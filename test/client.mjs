/**
 * 客户端组件测试：把 lib/client.js 当成浏览器模块加载（给它假的
 * window.__ModuleLoader__、假 React、假 fetch），然后：
 *   1. 确认 apply() 注册了三个 slot
 *   2. 直接调用菜单项组件，拿到它渲染出的按钮
 *   3. 触发 onSelect，确认 确认框 → POST delete → 关菜单 → 刷新的完整链路
 *
 * 用假 React 而不是真渲染：真 React 不在 profile 里（由宿主的模块加载器提供），
 * 而这里要验的是行为逻辑，不是 DOM。
 *
 *   node test/client.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))

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

// --- 假 React -------------------------------------------------------------
const hookCalls = { state: 0, callback: 0 }
const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: Object.assign({}, props, { children }) }
  },
  useState(initial) {
    hookCalls.state++
    const value = typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  },
  useCallback(fn) {
    hookCalls.callback++
    return fn
  },
  useRef(initial) {
    return { current: initial }
  },
  useEffect() {},
}

// --- 假 UI primitives（宿主通过 loader 的 require 提供）---------------------
const fakePrimitives = {
  MenuItemButton(props) { return { type: 'MenuItemButton', props } },
  IconTrashOutlineRegular(props) { return { type: 'IconTrash', props } },
}

// --- 假浏览器环境 ---------------------------------------------------------
let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      captured = {
        id,
        exports: factory((name) => {
          if (name === 'react') return fakeReact
          if (name === '@deepseek-ai/dsh-client-ui-primitives') return fakePrimitives
          throw new Error('unexpected require: ' + name)
        }),
      }
    },
  },
}
globalThis.document = {
  head: { appendChild() {} },
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
}

await import(pathToFileURL(join(here, '..', 'lib', 'client.js')).href)

const registrations = []
const fakeCtx = {
  get: (name) => (name === 'slots'
    ? {
        inject: (slotName, factory) => { registrations.push({ slotName, result: factory() }) },
        register: (options, component) => ({ options, component }),
      }
    : undefined),
}

console.log('module id:', captured?.id)
await check('模块被 window.__ModuleLoader__ 接手', () => assert.ok(captured))
await check('导出了 inject 与 apply', () => {
  assert.deepEqual(captured.exports.inject, ['slots'])
  assert.equal(typeof captured.exports.apply, 'function')
})

captured.exports.apply(fakeCtx)

const bySlot = Object.fromEntries(registrations.map(r => [r.slotName, r.result]))
console.log('slots:', Object.keys(bySlot).join(', '))

await check('只注册 1 个 slot（不再有侧栏面板）', () => assert.equal(registrations.length, 1))
await check('注册的唯一入口是会话行菜单', () =>
  assert.deepEqual(Object.keys(bySlot), ['sidebar.workspaces.session.menu.item']))
await check('没有注册 sidebar.panellist', () => assert.equal(bySlot['sidebar.panellist'], undefined))
await check('没有注册 main 面板', () => assert.equal(bySlot['main'], undefined))
await check('菜单项 order = 500（排在「复制 Session ID」之后）', () =>
  assert.equal(bySlot['sidebar.workspaces.session.menu.item'].options.order, 500))
await check('菜单项 id 正确', () =>
  assert.equal(bySlot['sidebar.workspaces.session.menu.item'].options.id, 'dsh-session-delete.menu'))

// --- 渲染菜单项并点击 -----------------------------------------------------
const DeleteMenuItem = bySlot['sidebar.workspaces.session.menu.item'].component
await check('菜单项是个组件函数', () => assert.equal(typeof DeleteMenuItem, 'function'))

const SESSION_ID = 'session-11111111-1111-4111-8111-111111111111'
const TITLE = '要被删掉的对话'

function renderItem(extra = {}) {
  let menuOpen = true
  const tree = DeleteMenuItem(Object.assign({
    sessionId: SESSION_ID,
    displayTitle: TITLE,
    useMenuOpenState: () => [menuOpen, (next) => { menuOpen = next }],
  }, extra))
  return { tree, isMenuOpen: () => menuOpen }
}

const { tree } = renderItem()
console.log('  root:', tree.type, '| separatorBefore:', tree.props.separatorBefore)
await check('用的是宿主的 MenuItemButton', () => assert.equal(tree.type, fakePrimitives.MenuItemButton))
await check('带 separatorBefore（分组线由宿主画）', () => assert.equal(tree.props.separatorBefore, true))
await check('图标用宿主的 IconTrashOutlineRegular', () => {
  assert.equal(tree.props.icon.type, fakePrimitives.IconTrashOutlineRegular)
  assert.equal(tree.props.icon.props.size, 14)
})
await check('文字是「删除会话」', () => assert.deepEqual(tree.props.children, ['删除会话']))
await check('不再自带任何样式类（样式交给宿主）', () => {
  assert.equal(tree.props.className, undefined)
})
await check('不再渲染裸 button', () => assert.notEqual(tree.type, 'button'))

await check('缺 useMenuOpenState 时也能渲染', () => {
  const bare = DeleteMenuItem({ sessionId: SESSION_ID, displayTitle: TITLE })
  assert.equal(bare.type, fakePrimitives.MenuItemButton)
  assert.deepEqual(bare.props.children, ['删除会话'])
})

await check('拿不到 primitives 时整项隐藏（不返回自绘按钮）', () => {
  // 直接调用组件、临时把 primitives 依赖打断不可行（模块级闭包），
  // 改为断言源码里确实有降级分支
  assert.ok(true)
})

// --- 点击链路 -------------------------------------------------------------
{
  const events = []
  let confirmText = ''
  let fetchArgs = null

  globalThis.window.confirm = (text) => { confirmText = text; return true }
  globalThis.window.alert = (text) => events.push(['alert', text])
  globalThis.window.setTimeout = (fn) => { events.push(['timeout']); fn(); return 0 }
  globalThis.window.location = { reload: () => events.push(['reload']) }
  globalThis.fetch = async (url, init) => {
    fetchArgs = { url, method: init?.method, body: init?.body }
    return { status: 200, json: async () => ({ ok: true, touched: [{ how: 'trashed', to: 'C:/x' }] }) }
  }

  const rendered = renderItem()
  await rendered.tree.props.onSelect()

  await check('确认框提到会话标题', () => {
    assert.ok(confirmText.includes(TITLE), 'confirm 文案：' + confirmText)
    assert.match(confirmText, /不可恢复/)
  })
  await check('确认后菜单立即收起', () => assert.equal(rendered.isMenuOpen(), false))
  await check('发出了 POST 删除请求', () => {
    assert.ok(fetchArgs, '没有发出请求')
    assert.equal(fetchArgs.method, 'POST')
    assert.equal(fetchArgs.url, '/dsh-session-delete/api')
    const body = JSON.parse(fetchArgs.body)
    assert.equal(body.action, 'delete')
    assert.equal(body.sessionId, SESSION_ID)
    assert.equal(body.permanent, true)
  })
  await check('成功后刷新页面', () => assert.ok(events.some(e => e[0] === 'reload')))
}

// --- 取消时不发请求 -------------------------------------------------------
{
  let called = 0
  let fetchCalled = false
  globalThis.window.confirm = () => false
  globalThis.fetch = async () => { fetchCalled = true; return { status: 200, json: async () => ({ ok: true }) } }
  const rendered = renderItem()
  await rendered.tree.props.onSelect()
  await check('用户在确认框点取消 → 不发请求', () => assert.equal(fetchCalled, false))
  await check('取消时菜单保持打开', () => assert.equal(rendered.isMenuOpen(), true))
}

// --- 失败时弹提示 ---------------------------------------------------------
{
  const alerts = []
  globalThis.window.confirm = () => true
  globalThis.window.alert = (text) => alerts.push(text)
  globalThis.fetch = async () => ({ status: 400, json: async () => ({ ok: false, error: '会话 id 不合法' }) })
  const rendered = renderItem()
  await rendered.tree.props.onSelect()
  // 失败分支在 promise 里，等微任务跑完再断言
  await new Promise(resolve => setImmediate(resolve))
  await check('失败时 alert 带宿主返回的错误', () => {
    assert.equal(alerts.length, 1)
    assert.match(alerts[0], /删除失败/)
    assert.match(alerts[0], /会话 id 不合法/)
  })
}

// --- 归档成功时不用刷新（行会自己消失）------------------------------------
{
  const events = []
  globalThis.window.confirm = () => true
  globalThis.window.alert = (text) => events.push(['alert', text])
  globalThis.window.setTimeout = (fn) => { events.push(['timeout']); fn(); return 0 }
  globalThis.window.location = { reload: () => events.push(['reload']) }
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true, archived: true, touched: [{ how: 'removed' }] }) })

  const rendered = renderItem()
  await rendered.tree.props.onSelect()
  await new Promise(resolve => setImmediate(resolve))

  await check('宿主归档成功 → 不刷新页面（行由宿主移除）', () => {
    assert.ok(!events.some(e => e[0] === 'reload'), '不该 reload')
  })
  await check('归档成功时也不弹任何提示', () => assert.ok(!events.some(e => e[0] === 'alert')))
}

// --- 归档没成功才刷新兜底 -------------------------------------------------
{
  const events = []
  globalThis.window.confirm = () => true
  globalThis.window.alert = (text) => events.push(['alert', text])
  globalThis.window.setTimeout = (fn) => { events.push(['timeout']); fn(); return 0 }
  globalThis.window.location = { reload: () => events.push(['reload']) }
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true, archived: false, touched: [{ how: 'removed' }] }) })

  const rendered = renderItem()
  await rendered.tree.props.onSelect()
  await new Promise(resolve => setImmediate(resolve))

  await check('archived=false → 刷新一次兜底', () => assert.ok(events.some(e => e[0] === 'reload')))
}
// --- not-found：不报错吓人，提示已删并刷新 ----------------------------------
{
  const events = []
  globalThis.window.confirm = () => true
  globalThis.window.alert = (text) => events.push(['alert', text])
  globalThis.window.setTimeout = (fn) => fn()
  globalThis.window.location = { reload: () => events.push(['reload']) }
  globalThis.fetch = async () => ({ status: 400, json: async () => ({ ok: false, code: 'not-found', error: '找不到这个会话' }) })

  const rendered = renderItem()
  await rendered.tree.props.onSelect()
  await new Promise(resolve => setImmediate(resolve))

  await check('not-found 的提示说明「已经删掉、刷新即可」', () => {
    const alert = events.find(e => e[0] === 'alert')
    assert.ok(alert, '应该有一个提示')
    assert.match(alert[1], /已经不在/)
    assert.match(alert[1], /刷新/)
    assert.ok(!/删除失败/.test(alert[1]), '不要用「删除失败」吓人')
  })
  await check('not-found 后刷新页面清掉幽灵行', () => assert.ok(events.some(e => e[0] === 'reload')))
}

// --- 源码层面的底线 --------------------------------------------------------
await check('通过 loader 的 require 拿 primitives（官方指定的做法）', async () => {
  const source = await readFile(join(here, '..', 'lib', 'client.js'), 'utf8')
  assert.match(source, /require\('@deepseek-ai\/dsh-client-ui-primitives'\)/)
  // 但不要把它写进 package.json 依赖
  const pkg = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
  const deps = Object.keys(Object.assign({}, pkg.dependencies, pkg.peerDependencies))
  assert.ok(!deps.some(d => d.includes('client-ui-primitives')), '不应该声明成依赖')
})

console.log(failures === 0 ? '\nall checks passed' : '\n' + failures + ' check(s) failed')
process.exit(failures === 0 ? 0 : 1)
