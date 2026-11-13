# DSH 会话删除插件（dsh-session-delete）

**一键彻底删除 DeepSeek Harness 里的对话**：删掉侧栏那一行，连磁盘上的会话日志一起清掉。

> 关键词：DSH 删除会话 · 会话删除 · 删除对话 · 删除聊天记录 · 清理会话 · 会话管理 · DeepSeek Harness 插件 ·
> delete conversation · delete session · session cleanup

给 [DeepSeek Harness](https://github.com/deepseek-ai) 补上「**真正删除会话**」的能力。

DSH 侧栏原本只有「归档会话」——归档只是把行藏起来，日志仍然留在磁盘上，
持久化层（`dsh-session-persistence-jsonl`）也明确不提供删除接口。这个插件在会话行的
`...` 菜单里加一项「删除会话」，点确认后这一行当场消失，日志从磁盘抹掉。

## 安装

插件以 DSH bundle 的形式挂进某个 profile。仓库没有发布到 npm，用 git 地址安装：

```powershell
dsh plugin --profile desktop add github:wsk4973/dsh-session-delete
```

或者手动放：

```powershell
# 1. 把仓库放到任意目录，然后软链进 profile
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-session-delete" `
  -Target "<仓库路径>"

# 2. 把包名加进 profile 的 bundle 列表
#    ~/.dsh/profiles/desktop/package.json → dsh.profile.bundles 末尾加 "dsh-session-delete"

# 3. 重启 DeepSeek Harness
```

卸载：从 `dsh.profile.bundles` 去掉包名，删掉 `node_modules` 下的链接，重启。

要求：宿主版本里有 `sidebar.workspaces.session.menu.item` 这个 list slot
（客户端插件用它往会话行菜单里插项）。开发时对照的是 DSH 桌面端。

## 用法

会话行 `...` 菜单底部多一项 **🗑 删除会话**（带分隔线，排在「复制 Session ID」之后）：

- 点击 → 确认框（写明标题、不可恢复、「删的是当前对话会中断」）
- 确认 → 这一行当场消失，同时删除磁盘上的会话日志

它注册的 `order` 是 500，宿主自带的项是 pin 100 / rename 200 / fork 300 /
archive 400 / session-id 450，所以插件项落在最后。

## 为什么是「先归档再删」

DSH 侧栏的行由**宿主进程内存**决定，磁盘只是备份。只删文件的话，行会一直挂在那儿
（宿主不知道它没了），也就是「删了还在」的幽灵行。所以顺序固定为：

1. 调宿主自己的 `workspaceRegistry.archiveSession(id, { stopActivity: true })`
   —— 这是唯一能让那一行立刻消失的原生操作，行由宿主推送移除
2. 再删磁盘三处：会话目录、`workspace.json` 里的登记、`session_projcache` 标题缓存

归档成功时客户端**不刷新页面**（行已经没了）；只有归档失败（会话不在宿主内存里）
才刷新一次兜底。

一次删除会碰到的三处状态：

| 位置 | 作用 |
|---|---|
| `$DSH_HOME/sessions/<workspace-key>/session-<id>/` | 会话日志本体 |
| `$DSH_HOME/storages/workspace.json` | 会话登记表（所属工作区、归档集、置顶集） |
| `$DSH_HOME/storages/session_projcache/sessions/<id>.json` | 标题等投影缓存 |

任意一处留着，侧栏都可能把这一行再显示出来。

## 配置

默认彻底删除。想留个后悔药——让文件先进回收目录而不是直接抹掉——在 profile 的
`cordis.patch.yml` 里改：

```yaml
- id: dsh-session-delete
  config:
    trash: true
```

打开后，文件会被移动到 `$DSH_HOME/session-trash/<时间戳>-<session-id>/`。

## HTTP 接口

宿主半边注册了一个路由，浏览器半边和 curl 都能用：

```
POST /dsh-session-delete/api
{"action":"delete","sessionId":"session-…","permanent":true}
```

`permanent` 省略时遵循上面的 `trash` 配置。响应里 `archived` 表示宿主归档是否成功
（客户端据此决定要不要刷新兜底），`touched` 列出实际清掉的文件。

## 测试

```powershell
node test/smoke.mjs    # 存储层：删除、回收目录、幽灵条目、路径穿越、归档钩子
node test/http.mjs     # 路由层：POST delete / 错误码
node test/client.mjs   # 客户端：slot 注册、组件渲染、确认/取消/失败链表
```

三个都只操作临时目录和假对象，不碰真实会话。

## 已知边界

- 删掉当前正在对话的那个会话会打断这一轮。确认框里有提示。
- 删除会直接改写 `workspace.json`。写入用「临时文件 + rename」保证文件不会被写坏，
  但如果删除的瞬间宿主正好也在写这张表，两边仍可能互相覆盖（窗口很小）。
- 归档集合里可能残留一个指向已删会话的 id，只影响「仅显示已归档」这一视图。

## License

MIT
