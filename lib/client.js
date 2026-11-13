/**
 * dsh-session-delete — CLIENT half（浏览器半边）
 *
 * 加载器格式：`window.__ModuleLoader__.load({ id, factory })`。
 * 这个文件不是 ESM —— 它是 DSH 客户端模块系统的 CJS 懒加载单元。
 *
 * 只做一件事：往会话行的「...」菜单里加一项「删除会话」。
 * 删除顺序由宿主半边负责（先归档让行消失，再删磁盘），这里只负责
 * 确认、发请求、以及失败时的提示。
 *
 * 与宿主通信：
 *   POST /dsh-session-delete/api  { action: 'delete', sessionId, permanent }
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var el = React.createElement

    // 宿主的 UI 基线外部：Module Loader 包可以直接从 loader 的 require 里拿
    // `@deepseek-ai/dsh-client-ui-primitives`（官方文档指定的做法，不用声明依赖）。
    // 拿不到就不显示这一项 —— 宁可没有，也不要塞个自家样式的行破坏观感。
    var primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (error) {
      primitives = null
    }

    var API = '/dsh-session-delete/api'

    /** 调宿主接口；非 2xx 也尽量把 JSON 里的 error 抛出来，并把 code 一起带上。 */
    async function callApi(input) {
      var response = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      var payload = null
      try {
        payload = await response.json()
      } catch (error) {
        throw new Error('宿主返回了非 JSON 内容（HTTP ' + response.status + '）')
      }
      if (!payload || payload.ok !== true) {
        var failure = new Error((payload && payload.error) || ('HTTP ' + response.status))
        failure.code = payload && payload.code
        throw failure
      }
      return payload
    }

    /** 兜底刷新：只有宿主没能归档（会话已不在进程内）时才需要。 */
    function reloadSoon() {
      if (typeof window === 'undefined' || typeof window.setTimeout !== 'function') return
      window.setTimeout(function () { window.location.reload() }, 120)
    }

    /** 失败提示：not-found 说明已经没了，刷新即可；其它照实报错。 */
    function reportFailure(error) {
      if (typeof window === 'undefined' || typeof window.alert !== 'function') return
      if (error && error.code === 'not-found') {
        window.alert('这个会话已经不在了。页面会刷新一次，那一行就没了。')
        reloadSoon()
        return
      }
      window.alert('删除失败：' + String((error && error.message) || error))
    }

    /**
     * 会话行「...」菜单里的「删除会话」。
     *
     * 这个 slot 只给行身份（sessionId / displayTitle）和一个 `useMenuOpenState`，
     * 其余全部自己负责；菜单的关闭也由这一项通过 setMenuOpen(false) 完成。
     * 外观一律交给宿主的 `MenuItemButton` —— 图标槽、行高、hover、分组线都在组件里。
     */
    function DeleteMenuItem(props) {
      var sessionId = props && props.sessionId
      var displayTitle = props && props.displayTitle
      var useMenuOpenState = props && props.useMenuOpenState

      var menuState = typeof useMenuOpenState === 'function' ? useMenuOpenState() : [false, function () {}]
      var setMenuOpen = typeof menuState[1] === 'function' ? menuState[1] : function () {}

      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]

      var onSelect = React.useCallback(function () {
        if (!sessionId || busy) return
        var label = displayTitle || sessionId
        var question = '彻底删除会话「' + label + '」？\n\n'
          + '会先从列表里移除，再把会话日志、登记表条目和标题缓存从磁盘上抹掉，不可恢复。\n\n'
          + '如果删的是当前正在对话的那个，这一轮会中断。'
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(question)) return

        setBusy(true)
        setMenuOpen(false)

        callApi({ action: 'delete', sessionId: sessionId, permanent: true }).then(function (payload) {
          // 宿主归档成功 → 这一行由宿主自己撤掉，不用刷新
          if (!payload || payload.archived !== true) reloadSoon()
        }).catch(function (error) {
          setBusy(false)
          reportFailure(error)
        })
      }, [sessionId, displayTitle, busy, setMenuOpen])

      if (primitives === null || typeof primitives.MenuItemButton !== 'function') return null

      var icon = typeof primitives.IconTrashOutlineRegular === 'function'
        ? el(primitives.IconTrashOutlineRegular, { size: 14 })
        : undefined

      return el(primitives.MenuItemButton, {
        separatorBefore: true,
        icon: icon,
        disabled: busy,
        onSelect: onSelect,
      }, busy ? '正在删除…' : '删除会话')
    }

    function apply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined || typeof slots.register !== 'function') return

      // order 500：排在宿主自带的「复制 Session ID」(450) 之后，自带分隔线
      slots.inject('sidebar.workspaces.session.menu.item', function () {
        return slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'dsh-session-delete.menu',
          order: 500,
        }, DeleteMenuItem)
      })
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
