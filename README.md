# dsh-turn-delete

[English](README.en.md) | 中文

从 DeepSeek Harness 的对话中删除**一个**完整且已结束的 Turn（轮次），不删除也不替换整个 Session：该轮的提问、助手回复与工具记录会从后续模型上下文中移除，而 Session id、标题、工作区关联、之后的轮次以及原始 append-only 事件日志全部保留。每个已完成的顶层轮次，其最后一条助手回复旁会出现一个垃圾桶按钮。

> 本仓库是 [hanshenmesen/dsh-turn-delete](https://github.com/hanshenmesen/dsh-turn-delete) 的**独立延续版**。上游主分支暂未合并本仓库的兼容性修复，因此这里独立维护，并跟进 DeepSeek Harness `0.1.5-rc.2` 的 surface 规则与 `0.2.0-rc.1` 的插件兼容性闸门。

## 演示

确认后删除中间轮次，同时保留原 Session 与后续轮次。演示录制于 DeepSeek Harness `0.1.0-rc.7`，操作方式与当前版本一致。

![删除单个轮次而不删除 Session](https://github.com/hanshenmesen/dsh-turn-delete/releases/download/v0.1.0/dsh-turn-delete-demo.gif)

## 功能

- 删除按钮只出现在普通 Session 已完成的顶层轮次上，subagent 会话不显示。
- 删除前必须确认；Session 正在运行时按钮不可用。
- **立即生效**：删除成功后该轮的行就地隐藏，不需要切换会话再切回来（持久 tombstone 会在之后任何一次整窗渲染时继续把它隐藏）。
- 删除由一条持久记录承担：刷新页面或重启 profile 后，被删轮次依然不出现。
- Session 的 system prompt 节点永远不会被算进删除区间。
- 重复提交同一次删除是幂等的。

目标轮次尚未结束，或已与其他历史一起被折叠进 compaction 摘要时，插件会拒绝删除：摘要是整体替换，无法单独摘除其中某一轮。这种拒绝会如实说明原因；插件内部出错时会报告「删除失败」并附带原因，不会再误报成「任务正在运行」。

## 安装

从本地目录（开发调试）：

```sh
dsh plugin --profile web add -w link:/absolute/path/to/dsh-turn-delete
```

从 GitHub 安装（私有仓库需要本机已有对应凭据）：

```sh
dsh plugin --profile web add github:TiJun-Prime/dsh-turn-delete
```

从预构建的 GitHub Release 安装（发布 Release 之后可用）：

```sh
dsh plugin --profile web add https://github.com/TiJun-Prime/dsh-turn-delete/releases/latest/download/dsh-turn-delete.tgz
```

安装后重启 `dsh web`（桌面版重启应用）。卸载：

```sh
dsh plugin --profile web remove dsh-turn-delete
```

## 与上游的差异（0.2.0）

1. **适配 DSH 0.1.5-rc.2**：surface 替换操作改为 `{ op: 'replace', startSeq, endSeq }`；tombstone 载体由 `assistant/message` 改为**空内容的 `system/message`**——0.1.5 明令禁止在 `assistant/message` 上携带 `sourceEventSeqs`，而空 system 节点既声明来源、又不投影出任何模型消息。旧版本写入的 tombstone 仍会被识别。
2. **system prompt 不再被算进删除区间**：0.1.5 的 `assertSystemHeadRewrite` 保护 surface 节点 0，第一轮的区间曾在某些会话里包含该节点而直接失败。
3. **错误如实上报**：内部异常（例如内核 API 变化）不再被包装成 `AGENT_BUSY`，新增 `DELETE_FAILED`；只有 Agent 确实非 idle 时才提示任务正在运行。
4. **删除后立即隐藏**：聊天的 turn-tail 行在实时追加时不会重渲染，因此由删除动作直接就地隐藏被删轮次的行。
5. **工程化**：构建/检查脚本在 Windows 上正常工作（`.bin` shim 问题），`npm run check` 增加「用真实内核经 HTTP 路由删除构建产物中的中间轮次」的 smoke 测试。

## 0.2.1：适配 0.2.0-rc.1 的插件兼容性闸门

DeepSeek Harness `0.2.0-rc.1` 起，profile 启动时会用 `evaluatePluginCompatibility()` 检查每个插件的 `peerDependencies`：凡是名字等于 `@deepseek-ai/dsh` 或以其为前缀的 peer，都要求运行中的内核版本满足其 semver 范围（`includePrerelease: true`）；不满足的插件**不报错、也不加载**——loader 条目停在 `enabled: false`，插件面板显示「已进入 profile bundle 层但本次未能热挂载;重启后生效」，而内核日志里没有任何相关行。

两个坑：

- 只声明测过的旧版本（例如 `^0.1.5-rc.2`）在 `0.2.0-rc.1` 上判定为 false → 直接不加载。
- 预发布版本的区间写法很反直觉：`>=0.1.5-rc.2 <0.3.0` 同样判定为 false（该范围内没有任何稳定版元组），必须写成 `^0.1.5-rc.2 || ^0.2.0-rc.1` 这类联合范围。

0.2.1 因此把 5 个 `@deepseek-ai/dsh-*` peer 的范围改为 `^0.1.5-rc.2 || ^0.2.0-rc.1`，一份包同时支持两条内核线；**代码无需改动**（surface 事件、`system/message` 形状、`data-turn-tail` / `data-chat-flow-kind` DOM 契约在 0.2.0-rc.1 上均已逐项核对未变；slot 契约有一处收紧，见 0.2.3 一节）。

升级内核后发现按钮消失时，可在插件面板里重新启用本插件（会写入 profile patch 行并热挂载），或直接重启应用；0.2.1 已可被闸门接受。

## 0.2.3：list 槽必须带 `id` —— 按钮不出现的真正原因

0.2.1 让插件重新通过兼容闸门、宿主半恢复挂载之后，浏览器端的删除按钮仍然不出现，而且插件面板上看不出任何问题。真正的原因在浏览器控制台里：

```
Error: list slot "conversation.chat.turnTail" requires options.id
```

`0.2.0-rc.1` 收紧了 slot 契约：**`kind: "list"` 的槽在 `register()` 时强制要求 `options.id`**。本插件的 turn-tail 注册当时写作 `{ name: 'conversation.chat.turnTail', select: selectDeletedTurn }`（在 0.1.x 上合法），于是 `apply(ctx)` 在第二个注册处抛错 → cordis 回滚**整个插件 fiber** → 先前注册成功的 `conversation.chat.assistant-actions`（删除按钮本体）一并被撤销。表现就是「插件已加载、日志无异常、按钮不见了」。

0.2.3 的改动：

1. 两个 list 槽注册都补上稳定 `id`：turn-tail 用 `id: 'turn-delete'`（另加 `order: 50`）。`id` 是槽内单元键——新的 `id` 并列渲染，复用已有 `id` 则替换该格；`order` 只控制排序。
2. 新增回归测试：断言两个 list 槽注册项都必须带 string `id`，并断言 turn-tail 的 `select` 仍按 turn 数据选取（deleted → `{ hidden: true, turn }`，未删除 → `null`）。

顺带澄清两个容易混淆的 manifest 字段：

- `dsh.client.immediately` **与是否加载无关**：manifest 里的每个动态客户端包都会被 `create`。`false` 只是不写进行数据。
- `dsh.client.inject` 只接受**动态客户端包名**。写进非动态包（例如 `@deepseek-ai/dsh-client-ui-primitives`，其 `package.json` 没有 `dsh.client` 字段、也没有 `lib/client.js`）不会报错，但也不会生效——未知项被静默跳过，0.2.3 已移除。

## 0.2.5：v4 的 source 按「角色」校验 —— 删除失败的真正原因

0.2.4 让按钮回来了，但点删除会弹出：

```
删除失败：插件内部出错或与当前内核不兼容。 — format v4 message requires a producer-owned source kind
```

而且那个会话之后每次发消息都报同一句。原因在 `0.2.0-rc.1` 的**会话格式 v4**对消息 source 的校验规则：

- **v4 按「角色」而不是「生产者」校验 source**：`system/message` 的 source 必须是 `{ kind: "system-prompt" }`，`assistant/message` 必须是 `{ kind: "model", provider, model }`。用真实 `0.2.0-rc.1` 内核逐项实测（内存中造 3 轮、删中间轮、再逐个替换 source 回放）：

  | tombstone source | 行准入 | 会话回放 |
  | --- | --- | --- |
  | `{ kind: 'plugin', plugin: 'dsh-turn-delete' }`（0.1.x 写法） | ✗ `format v4 message requires a producer-owned source kind` | ✗ `message must have system-prompt source` |
  | `{ kind: 'plugin:dsh-turn-delete' }`（v3→v4 迁移的改写形式） | ✓ | ✗ `must have system-prompt source` |
  | `{ kind: 'runtime-context' }` | ✓ | ✗ `must have system-prompt source` |
  | `{ kind: 'system-prompt' }` | ✓ | ✓ |

- 因此 0.2.5 让 tombstone 的 source **跟随会话自身的格式版本**：`session.header.version >= 4` 时写 `{ kind: 'system-prompt' }`（即内核自己的空系统消息），v3 仍写 `{ kind: 'plugin', plugin: 'dsh-turn-delete' }`——0.1.x 的 seed 校验器恰好相反（`seed system/message … message must have plugin source`），一刀切必然弄坏另一条内核线。
- 身份识别随之改为**结构化**：v4 上不再有生产者字段可用，所以「空内容的 `system/message` + `surfaceOp: replace`」本身就是 tombstone；旧日志里的 `plugin` 形状与更早的 `assistant/message` 形状继续被识别，历史删除不会复活。

0.2.5 验证证据（真实 `0.2.0-rc.1` 内核，全内存、不碰用户会话）：删除中间轮 → `receipt { turn: 2, seq: 18 }`，tombstone source `{ kind: 'system-prompt' }`，模型面 `["q1","a1","q3","a3"]`，并用 `Session.create(id, seed, header, …)` 重建整条日志成功（tombstone 仍在 seq 18、被删轮次仍不在模型面）；三组负对照（legacy `plugin`、`plugin:<name>`、`runtime-context`）全部被同一校验器拒绝。

被写坏的会话（内存里挂着一条无法落盘的 pending 事件）不需要修磁盘：关掉该会话重新打开、或重启应用即可恢复——磁盘上的日志从未被污染。

## 0.2.4：图标改名 —— 重启后按钮仍不出现的原因

0.2.3 修好 slot 注册后重新加载，删除按钮依然不出现：宿主半状态是 `enabled: true, fiberPhase: "active"`，浏览器控制台里最初那条 `requires options.id` 也消失了，但动作行里什么都没有。第二个（也是最后一个）原因不在 slot，而在图标：

**`0.2.0-rc.1` 把 `@deepseek-ai/dsh-client-ui-primitives` 里所有带尺寸后缀的图标改名成了「笔画粗细」变体。**

| 0.1.x | 0.2.0-rc.1 |
| --- | --- |
| `IconTrashOutline16` | `IconTrashOutlineRegular`（1px 描边）/ `IconTrashOutlineMedium`（1.3px） |

本插件此前直接 `import { IconTrashOutline16 }`；在 `0.2.0-rc.1` 上这个导出不存在，而构建产物是 CJS interop（`x = __toESM(require(...))`），读出来是 `undefined`。把 `undefined` 当组件渲染会让 React 抛 `Element type is invalid`，**整条动作行渲染失败**——注册是成功的、宿主侧没有任何报错，所以从外面看只是「按钮不见了」。

0.2.4 的改动：

1. 新增 `src/client/trash-icon.tsx`：按 `IconTrashOutlineRegular → IconTrashOutline → IconTrashOutline16 → IconTrashOutlineMedium` 的顺序在**运行时**解析当前内核真正导出的图标名，一份 bundle 同时服务两条内核线；一个都解析不到时渲染内置的 16px SVG 兜底——以后再改名最多是换图形，不会再让按钮消失。
2. 新增 3 个回归测试：解析优先级、未知/空模块返回 `null`、兜底图形可渲染。

`Button` / `Modal` / `Tooltip` 的 props 已在两条内核线上逐项核对一致，无需改动。

## 设计

Host 端注册 `POST /dsh-turn-delete`：取得目标 Agent 的维护租约 → 校验目标轮次是一个完整闭合、且仍可独立删除的 surface 区间 → 追加持久替换事件 → 等待 `sessions.flush()` 完成后才返回成功。

替换事件是一条空内容的 `system/message`，携带 `surfaceOp: { op: 'replace', startSeq, endSeq }` 以及它所遮蔽的 `sourceEventSeqs`。

浏览器端使用公开的 `conversation.chat.assistant-actions` 与 `conversation.chat.turnTail` slot：一个 Conversation definition 把持久 tombstone 投影到目标 Turn 的 Location data 上，标记组件据此隐藏相邻 Turn tail 之间的 Chat 行。DeepSeek Harness 目前还没有公开「整轮可见性」扩展点，所以这层呈现兼容被限制在行范围内；**模型上下文的删除完全不依赖它**。

## 兼容性

- DeepSeek Harness `0.1.5-rc.2` 与 `0.2.0-rc.1`（surface 替换使用 `{ op: 'replace', startSeq, endSeq }`）
- Node.js 22.19 或更高版本
- Web profile 与基于 Web 的桌面套壳

`peerDependencies` 声明为 `^0.1.5-rc.2 || ^0.2.0-rc.1`。内核升到未列出的版本时，`0.2.0-rc.1` 之后的 Harness 会拒绝加载本插件（见上一节）；此时需要更新本包，或在插件面板里为该精确版本显式授予兼容豁免。

DeepSeek Harness 仍处于 developer preview，surface API 会在版本之间变化。升级 Harness 后，建议新建一个含三个短轮次的临时 Session，并删除中间轮次做一次验证。

## 开发

```sh
npm install
npm run check
dsh plugin --profile web add -w link:/absolute/path/to/dsh-turn-delete
```

`npm run check` 会：类型检查 → 构建 Host/Browser 两半 → 运行单元与 UI 测试（真实内核对象 + jsdom）→ 用构建产物经真实 HTTP 路由对真实内核做一次删除 smoke → 校验 npm 包内容。

## 安全

与所有 DSH 插件一样，本包以 Harness 进程的权限运行，安装前应审阅源码。删除只改变后续模型上下文，原始 append-only 事件会为审计与回放保留。

## 许可证

MIT
