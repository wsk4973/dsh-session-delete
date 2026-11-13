/**
 * dsh-session-delete 冒烟测试：不依赖 DSH，直接对临时目录跑一遍
 * 列表 / 删除 / 参数校验，确认三处状态（会话目录、登记表、投影缓存）一起收尾。
 *
 *   node test/smoke.mjs
 */
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createStore, resolveHome, API_PATH, name } from '../lib/index.js'

const ID_A = 'session-11111111-1111-4111-8111-111111111111'
const ID_B = 'session-22222222-2222-4222-8222-222222222222'
const ID_C = 'session-33333333-3333-4333-8333-333333333333'
const WORKSPACE_KEY = '--C-Users-test-workspace--'

let failures = 0
async function check(label, fn) {
  try {
    await fn()
    console.log('  ok   ' + label)
  } catch (error) {
    failures++
    console.log('  FAIL ' + label + ' - ' + error.message)
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 投影缓存的最小形状（删除时要能被一起清掉）。 */
function cacheWithTitle(title) {
  return JSON.stringify({ version: 7, record: { rows: { title: { ver: 1, seq: 1, val: title } } } })
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'))
  const sessionsRoot = join(home, 'sessions', WORKSPACE_KEY)
  for (const id of [ID_A, ID_B]) {
    const dir = join(sessionsRoot, id)
    await mkdir(dir, { recursive: true })
    const log = join(dir, 'session.v4.jsonl.zstd')
    await writeFile(log, Buffer.alloc(2048, 7))
    // 把 mtime 拨到 10 分钟前：否则会被「正在使用」保护拦下（那是另一个用例）
    const old = new Date(Date.now() - 10 * 60 * 1000)
    await utimes(log, old, old)
    await utimes(dir, old, old)
  }
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { archivedSessionIds: [ID_B], pinnedSessionIds: [ID_A] },
    tables: {
      workspaces: {
        'ws-1': {
          path: 'C:\\Users\\test\\workspace',
          title: 'workspace',
          sessionIds: [ID_A, ID_C],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  }, null, 2))
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })
  await writeFile(join(cacheDir, ID_A + '.json'), cacheWithTitle('deleted chat'))
  await writeFile(join(cacheDir, ID_B + '.json'), cacheWithTitle('archived chat'))
  return { home, sessionsRoot, cacheDir }
}

console.log('plugin:', name, '| api:', API_PATH)

const { home, sessionsRoot, cacheDir } = await fixture()
const store = createStore(home)

console.log('\n[2] 删除到回收目录')
const removed = await store.remove(ID_A, { permanent: false })
await check('返回 ok', () => assert.equal(removed.ok, true))
await check('原目录已消失', async () => assert.equal(await exists(join(sessionsRoot, ID_A)), false))
const trash = await readdir(join(home, 'session-trash'))
await check('回收目录里正好一条', () => assert.equal(trash.length, 1))
await check('回收条目名带会话 id', () => assert.ok(trash[0].includes(ID_A)))
await check('回收目录里日志还在（可手动恢复）', async () => {
  assert.equal(await exists(join(home, 'session-trash', trash[0], 'session.v4.jsonl.zstd')), true)
})
await check('投影缓存 A 已删', async () => assert.equal(await exists(join(cacheDir, ID_A + '.json')), false))
await check('缓存 B 没被误删', async () => assert.equal(await exists(join(cacheDir, ID_B + '.json')), true))

const registry = JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8'))
await check('登记表里 A 被摘掉', () => assert.deepEqual(registry.tables.workspaces['ws-1'].sessionIds, [ID_C]))
await check('置顶集里 A 被摘掉', () => assert.deepEqual(registry.global.pinnedSessionIds, []))
await check('归档集不受影响（B 还在）', () => assert.deepEqual(registry.global.archivedSessionIds, [ID_B]))

console.log('\n[3] 幽灵条目与错误输入')
const ghost = await store.remove(ID_C, { permanent: false })
await check('只有登记表的会话也能删', () => assert.equal(ghost.ok, true))
const afterGhost = JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8'))
await check('删完后 sessionIds 为空', () => assert.deepEqual(afterGhost.tables.workspaces['ws-1'].sessionIds, []))

const missing = await store.remove('session-44444444-4444-4444-8444-444444444444')
await check('不存在的会话返回错误', () => {
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'not-found')
  assert.match(missing.error, /找不到/)
})
await check('路径穿越被拒绝', async () => {
  const bad = await store.remove('../../etc/passwd')
  assert.equal(bad.ok, false)
  assert.match(bad.error, /不合法/)
})
await check('非字符串被拒绝', async () => {
  const bad = await store.remove(undefined)
  assert.equal(bad.ok, false)
})

console.log('\n[4] 彻底删除')
const permanent = await store.remove(ID_B, { permanent: true })
await check('返回 ok', () => assert.equal(permanent.ok, true))
await check('磁盘上真的没了', async () => assert.equal(await exists(join(sessionsRoot, ID_B)), false))
await check('回收目录里没有多出条目', async () => assert.equal((await readdir(join(home, 'session-trash'))).length, 1))

console.log('\n[5] 活会话：先归档再删（这样侧栏立刻消失）')
{
  const archivedIds = []
  const ID_LIVE = 'session-55555555-5555-4555-8555-555555555555'
  const dir = join(sessionsRoot, ID_LIVE)
  await mkdir(dir, { recursive: true })
  const log = join(dir, 'session.v4.jsonl.zstd')
  await writeFile(log, Buffer.alloc(1024, 9))
  const old = new Date(Date.now() - 60 * 60 * 1000)
  await utimes(log, old, old)
  await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
    global: { archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { 'ws-1': { path: 'C:\\ws', sessionIds: [ID_LIVE], updatedAt: '' } } },
  }, null, 2))

  const liveStore = createStore(home, {
    isLive: (id) => id === ID_LIVE,
    archive: async (id) => { archivedIds.push(id); return true },
  })

  const result = await liveStore.remove(ID_LIVE, { permanent: true })
  await check('活会话也能删，不再报错', () => assert.equal(result.ok, true))
  await check('先调了宿主归档（这一步让行立刻消失）', () => assert.deepEqual(archivedIds, [ID_LIVE]))
  await check('返回值带 archived=true', () => assert.equal(result.archived, true))
  await check('文件确实被删了', async () => assert.equal(await exists(dir), false))
  await check('登记表里也没了', async () => {
    const reg = JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8'))
    assert.deepEqual(reg.tables.workspaces['ws-1'].sessionIds, [])
    assert.deepEqual(reg.global.archivedSessionIds, [])
  })
}

console.log('\n[6] 空会话 / 归档失败时的兜底')
{
  // 宿主内存里有、磁盘上没有任何文件（空会话）—— 之前正是这种行删不掉
  const ID_EMPTY = 'session-66666666-6666-4666-8666-666666666666'
  const archivedIds = []
  const emptyStore = createStore(home, {
    isLive: (id) => id === ID_EMPTY,
    archive: async (id) => { archivedIds.push(id); return true },
  })
  const result = await emptyStore.remove(ID_EMPTY, { permanent: true })
  await check('空会话不再报「找不到」', () => assert.equal(result.ok, true))
  await check('空会话也走了归档', () => assert.deepEqual(archivedIds, [ID_EMPTY]))
  await check('没有文件可删时 touched 为空', () => assert.deepEqual(result.touched, []))

  // 归档接口失败时不能把删除也带崩，只是 archived=false（客户端据此刷新兜底）
  const ID_PLAIN = 'session-77777777-7777-4777-8777-777777777777'
  const pdir = join(sessionsRoot, ID_PLAIN)
  await mkdir(pdir, { recursive: true })
  await writeFile(join(pdir, 'session.v4.jsonl.zstd'), Buffer.alloc(256, 4))
  await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
    global: { archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { 'ws-1': { path: 'C:\\ws', sessionIds: [ID_PLAIN], updatedAt: '' } } },
  }, null, 2))
  const plainStore = createStore(home, {
    isLive: () => false,
    archive: async () => { throw new Error('boom') },
  })
  const ok = await plainStore.remove(ID_PLAIN, { permanent: true })
  await check('归档失败不影响删除', () => assert.equal(ok.ok, true))
  await check('归档失败时 archived=false', () => assert.equal(ok.archived, false))
  await check('文件照常被删', async () => assert.equal(await exists(pdir), false))
}
console.log('\n[7] home 解析')
await check('resolveHome() 返回绝对路径', () => assert.ok(resolveHome().length > 3))

await rm(home, { recursive: true, force: true })
console.log(failures === 0 ? '\nall checks passed' : '\n' + failures + ' check(s) failed')
process.exit(failures === 0 ? 0 : 1)
