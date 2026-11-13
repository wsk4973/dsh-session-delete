/**
 * dsh-session-delete — HOST half.
 *
 * DeepSeek Harness 的会话存储层（`dsh-session-persistence-jsonl`）明确不提供删除
 * 接口：日志只在磁盘上累积，侧栏只有「归档」。这个插件补上那块缺口，做法是把
 * 一次删除拆成三处一致地收尾：
 *
 *   1. `<DSH_HOME>/sessions/<workspace-key>/session-<id>/`   —— 会话日志目录
 *   2. `<DSH_HOME>/storages/workspace.json`                  —— 会话登记表
 *   3. `<DSH_HOME>/storages/session_projcache/sessions/*.json` —— 标题等投影缓存
 *
 * 三者任何一处留着，侧栏都可能再把这一行显示出来，所以必须一起清。
 *
 * 安全设计：
 *   - 默认不真删，而是把目录 **移动** 到 `<DSH_HOME>/session-trash/<时间戳>-<id>/`，
 *     用户可以从那里手动恢复；只有显式传 `permanent: true` 才 `rm -rf`。
 *   - 会话 id 必须先通过形状校验，目录也只从 `sessions/<workspace>/session-<id>` 里匹配，
 *     不接受任何外部路径。
 *   - 登记表写入用「临时文件 + rename」，避免写一半把 workspace.json 弄坏。
 *
 * 与 Client 的通信走 HTTP（和 dsh-draw 同一套路）：
 *   GET  /dsh-session-delete/api?action=list
 *   POST /dsh-session-delete/api   { action: 'list' | 'delete', sessionId, permanent }
 */

import { readFile, writeFile, rename, rm, mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Host 侧暴露给浏览器那一半的接口路径。 */
export const API_PATH = '/dsh-session-delete/api'

/** 会话 id 的合法形状；除此之外一律拒绝（同时挡掉路径穿越）。 */
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 最近这么久之内被写过的会话，界面上标成「可能正在使用」。 */
const RECENT_MS = 120_000

/** `$DSH_HOME`，缺省是 `~/.dsh`。 */
export function resolveHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : join(homedir(), '.dsh')
}

/** 读一个 JSON 文件，失败返回 fallback（配置文件缺失是正常情况）。 */
async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 原子写入：先写 `.tmp` 再 rename 覆盖。 */
async function writeJsonAtomic(file, value) {
  const tmp = file + '.' + process.pid + '.tmp'
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
}

/** 会话登记表的空结构。 */
function emptyRegistry() {
  return { unit: { name: 'workspace', version: 2 }, global: { archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: {} } }
}

/**
 * 一次删除会碰到的全部路径与读写逻辑。
 * 独立成工厂是为了能在测试里指向一个临时目录。
 *
 * @param {string} [home] $DSH_HOME
 * @param {{ isLive?: (sessionId: string) => boolean }} [hooks]
 *   isLive 由宿主注入：返回 true 表示这个会话此刻还在宿主进程里活着
 *   （列表行就是从这类活会话渲染出来的，删了文件也照样显示）。
 */
export function createStore(home = resolveHome(), hooks = {}) {
  const isLive = typeof hooks.isLive === 'function' ? hooks.isLive : () => false
  const archive = typeof hooks.archive === 'function' ? hooks.archive : async () => false
  const sessionsRoot = join(home, 'sessions')
  const registryFile = join(home, 'storages', 'workspace.json')
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  const trashRoot = join(home, 'session-trash')

  /** 登记表内容。 */
  async function readRegistry() {
    const parsed = await readJson(registryFile, null)
    if (!parsed || typeof parsed !== 'object') return emptyRegistry()
    parsed.global ??= {}
    parsed.tables ??= { workspaces: {} }
    parsed.tables.workspaces ??= {}
    parsed.global.archivedSessionIds ??= []
    parsed.global.pinnedSessionIds ??= []
    return parsed
  }

  /** 登记表里每一个会话的归属信息：id → { workspaceId, workspacePath, archived, pinned }。 */
  async function registryIndex() {
    const registry = await readRegistry()
    const index = new Map()
    for (const [workspaceId, workspace] of Object.entries(registry.tables.workspaces)) {
      const ids = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []
      for (const id of ids) {
        index.set(id, { workspaceId, workspacePath: workspace?.path ?? '', archived: false, pinned: false })
      }
    }
    for (const id of registry.global.archivedSessionIds) {
      const entry = index.get(id) ?? { workspaceId: null, workspacePath: '', archived: false, pinned: false }
      entry.archived = true
      index.set(id, entry)
    }
    for (const id of registry.global.pinnedSessionIds) {
      const entry = index.get(id) ?? { workspaceId: null, workspacePath: '', archived: false, pinned: false }
      entry.pinned = true
      index.set(id, entry)
    }
    return { registry, index }
  }

  /** 磁盘上属于 `id` 的会话目录（正常只有一个）。 */
  async function findSessionDirs(id) {
    const found = []
    let workspaces = []
    try {
      workspaces = await readdir(sessionsRoot, { withFileTypes: true })
    } catch {
      return found
    }
    for (const entry of workspaces) {
      if (!entry.isDirectory()) continue
      const candidate = join(sessionsRoot, entry.name, id)
      try {
        if ((await stat(candidate)).isDirectory()) found.push(candidate)
      } catch {
        /* 不是这个 workspace 下的会话 */
      }
    }
    return found
  }

  /**
   * 删除一个会话。
   *
   * 顺序很重要：先让宿主归档（这是唯一能让侧栏那一行立刻消失的原生操作），
   * 再删磁盘。只删文件的话，宿主内存里还留着这条会话，行会一直挂在列表里。
   *
   * 结果用 `code` 区分：
   *   - `not-found`：磁盘、登记表、宿主内存里都没有它
   *   - `invalid`：id 形状不对
   *   - 成功：`archived` 说明宿主归档是否成功
   *
   * @param {string} sessionId 会话 id（必须形如 session-<uuid>）。
   * @param {{ permanent?: boolean }} [options]
   *   permanent 为真才真删（否则移到回收目录）。
   */
  async function remove(sessionId, options = {}) {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
      return { ok: false, code: 'invalid', error: '会话 id 不合法：' + String(sessionId) }
    }

    const live = isLive(sessionId)
    const dirs = await findSessionDirs(sessionId)
    const { registry, index } = await registryIndex()
    const registered = index.has(sessionId)

    if (dirs.length === 0 && !registered && !live) {
      return {
        ok: false,
        code: 'not-found',
        error: '找不到这个会话（磁盘和登记表里都没有）',
      }
    }

    // 先归档：这是宿主唯一能让侧栏这一行立刻消失的原生操作。
    // 会话还活着（宿主进程里有它）时，光删文件行是不会走的 —— 先归档再删。
    let archived = false
    try {
      archived = await archive(sessionId) === true
    } catch {
      archived = false
    }

    const permanent = options.permanent === true
    const touched = []

    for (const dir of dirs) {
      if (permanent) {
        await rm(dir, { recursive: true, force: true })
        touched.push({ dir, how: 'removed' })
      } else {
        await mkdir(trashRoot, { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const target = join(trashRoot, stamp + '-' + sessionId)
        await rename(dir, target)
        touched.push({ dir, how: 'trashed', to: target })
      }
    }

    // 登记表：从所属工作区的 sessionIds、归档集、置顶集里一起摘掉
    let registryChanged = false
    for (const workspace of Object.values(registry.tables.workspaces)) {
      if (!Array.isArray(workspace?.sessionIds)) continue
      const next = workspace.sessionIds.filter(id => id !== sessionId)
      if (next.length !== workspace.sessionIds.length) {
        workspace.sessionIds = next
        workspace.updatedAt = new Date().toISOString()
        registryChanged = true
      }
    }
    for (const key of ['archivedSessionIds', 'pinnedSessionIds']) {
      const list = registry.global[key]
      if (!Array.isArray(list)) continue
      const next = list.filter(id => id !== sessionId)
      if (next.length !== list.length) {
        registry.global[key] = next
        registryChanged = true
      }
    }
    if (registryChanged) await writeJsonAtomic(registryFile, registry)

    // 投影缓存：标题、状态点都从这里读，留着会让侧栏继续认它
    const cached = join(cacheDir, sessionId + '.json')
    let hasCache = false
    try {
      await stat(cached)
      hasCache = true
    } catch {
      /* 没有缓存是常态 */
    }
    if (hasCache) {
      await rm(cached, { force: true })
      touched.push({ dir: cached, how: 'removed' })
    }

    return { ok: true, sessionId, permanent, archived, registryChanged, touched }
  }

  return { home, sessionsRoot, registryFile, cacheDir, trashRoot, remove }
}

/** 把请求体读完（上限 64KB，够用且防滥用）。 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.length
    if (size > 64_000) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text ? JSON.parse(text) : {}
}

/** 统一的 JSON 回包。 */
function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

export const name = 'dsh-session-delete'
export const inject = ['webServer']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ trash?: boolean }} [config]
 */
export function apply(ctx, config = {}) {
  const webServer = ctx.get('webServer')
  const store = createStore(undefined, {
    // 宿主自己报的活会话集合：侧栏里那些「删了还在」的行就是从这儿来的。
    // 服务缺席时退回 mtime 判断（见 remove 里的 RECENT_MS 分支）。
    isLive: (sessionId) => {
      try {
        const sessions = ctx.get('sessions')
        if (sessions !== undefined && sessions !== null && typeof sessions.has === 'function') {
          return sessions.has(sessionId) === true
        }
      } catch {
        /* 服务不可用就当它不是活的 */
      }
      return false
    },
    // 宿主唯一的「从侧栏移除」入口。归档把它放进 archivedSessionIds，
    // 默认筛选就是隐藏，所以这一行会立刻消失；之后我们再把记录和文件清掉。
    archive: async (sessionId) => {
      try {
        const workspaceRegistry = ctx.get('workspaceRegistry')
        if (workspaceRegistry === undefined || workspaceRegistry === null) return false
        if (typeof workspaceRegistry.archiveSession !== 'function') return false
        // stopActivity: 正在跑的回合也一并停掉（等同「停止并归档」），
        // 否则归档会被 refusing-while-active 挡回来
        await workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
        return true
      } catch (error) {
        ctx.logger?.warn?.('[dsh-session-delete] archive failed: ' + String((error && error.message) || error))
        return false
      }
    },
  })
  const disposers = []

  // 默认直接彻底删除；配置里写 `trash: true` 才改成先进回收目录（可手动恢复）
  const trashByDefault = config?.trash === true

  if (webServer && typeof webServer.register === 'function') {
    disposers.push(webServer.register({
      kind: 'exact',
      path: API_PATH,
      handler: async (req, res) => {
        try {
          const method = String(req.method || 'GET').toUpperCase()
          let input = {}
          if (method === 'POST') {
            input = await readBody(req)
          } else {
            const url = new URL(String(req.url || API_PATH), 'http://127.0.0.1')
            input = Object.fromEntries(url.searchParams.entries())
          }

          const action = String(input.action || (method === 'GET' ? 'list' : ''))

          if (action === 'delete') {
            const permanent = input.permanent === true || input.permanent === 'true'
              ? true
              : input.permanent === false || input.permanent === 'false'
                ? false
                : !trashByDefault
            const force = input.force === true || input.force === 'true'
            const result = await store.remove(String(input.sessionId || ''), { permanent, force })
            sendJson(res, result, result.ok ? 200 : 400)
            return
          }

          sendJson(res, { ok: false, error: '未知动作：' + action }, 400)
        } catch (error) {
          sendJson(res, { ok: false, error: String((error && error.message) || error) }, 500)
        }
      },
    }))
  } else {
    ctx.logger?.warn?.('[dsh-session-delete] 没有 webServer 服务，删除面板与接口都不会工作')
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 卸载时的失败不影响主流程 */
        }
      }
    })
  }
}

export default { name, inject, apply }
