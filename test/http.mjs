/**
 * 路由层测试：用一个假的 ctx 触发 apply()，拿到注册进来的 handler，
 * 再用假的 req/res 走一遍 POST delete 与几种错误输入，确认 JSON 收发正确。
 *
 *   node test/http.mjs
 */
import { mkdtemp, mkdir, writeFile, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const ID_A = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const home = await mkdtemp(join(tmpdir(), 'dsh-session-delete-http-'))
process.env.DSH_HOME = home
await mkdir(join(home, 'sessions', '--ws--', ID_A), { recursive: true })
const logA = join(home, 'sessions', '--ws--', ID_A, 'session.v4.jsonl.zstd')
await writeFile(logA, Buffer.alloc(1024))
const old = new Date(Date.now() - 10 * 60 * 1000)
await utimes(logA, old, old)   // 别被「正在使用」保护拦下
await mkdir(join(home, 'storages'), { recursive: true })
await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
  global: { archivedSessionIds: [], pinnedSessionIds: [] },
  tables: { workspaces: { 'ws-1': { path: 'C:\\ws', sessionIds: [ID_A], updatedAt: '' } } },
}))

// 必须在设置 DSH_HOME 之后导入
const { apply, API_PATH } = await import('../lib/index.js?http-test')

let handler = null
const fakeCtx = {
  get: (name) => (name === 'webServer'
    ? { register: (route) => { handler = route.handler; return () => {} } }
    : undefined),
  logger: { warn: (msg) => console.log('warn:', msg) },
  effect: (fn) => fn(),
}

apply(fakeCtx, { trash: false })
assert.ok(handler, 'webServer.register 应当被调用')
assert.equal(typeof handler, 'function')

/** 假请求：方法 + URL + JSON body。 */
function makeReq(method, url, body) {
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url,
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      if (text) yield Buffer.from(text)
    },
  }
}

/** 假响应：收集状态码与 body。 */
function makeRes() {
  const state = { status: 0, headers: null, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    end(body) {
      state.body = String(body ?? '')
    },
  }
}

let failures = 0
async function check(label, fn) {
  try {
    await fn()
    console.log('  ok   ' + label)
  } catch (error) {
    failures++
    console.log('  FAIL ' + label + ' — ' + error.message)
  }
}

console.log('route:', API_PATH)

const badRes = makeRes()
await handler(makeReq('POST', API_PATH, { action: 'nope' }), badRes)
await check('未知 action 返回 400', () => assert.equal(badRes.state.status, 400))

const badIdRes = makeRes()
await handler(makeReq('POST', API_PATH, { action: 'delete', sessionId: '../x' }), badIdRes)
await check('非法 id 返回 400 且带错误文案', () => {
  assert.equal(badIdRes.state.status, 400)
  assert.match(JSON.parse(badIdRes.state.body).error, /不合法/)
})

const delRes = makeRes()
await handler(makeReq('POST', API_PATH, { action: 'delete', sessionId: ID_A }), delRes)
const delBody = JSON.parse(delRes.state.body)
await check('删除返回 200', () => assert.equal(delRes.state.status, 200))
await check('默认彻底删除（touched 里是 removed）', () => {
  assert.equal(delBody.ok, true)
  assert.ok(delBody.touched.some(t => t.how === 'removed'))
})
await check('会话目录已移走', async () => {
  await assert.rejects(stat(join(home, 'sessions', '--ws--', ID_A)))
})

await rm(home, { recursive: true, force: true })
console.log(failures === 0 ? '\nall checks passed' : '\n' + failures + ' check(s) failed')
process.exit(failures === 0 ? 0 : 1)
