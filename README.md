# dsh-turn-delete

[English](README.en.md) | 中文

从 DeepSeek Harness 的对话中删除**一个**完整且已结束的 Turn（轮次），不删除也不替换整个 Session：该轮的提问、助手回复与工具记录会从后续模型上下文中移除，而 Session id、标题、工作区关联、之后的轮次以及原始 append-only 事件日志全部保留。每个已完成的顶层轮次，其最后一条助手回复旁会出现一个垃圾桶按钮。

> 本仓库是 [hanshenmesen/dsh-turn-delete](https://github.com/hanshenmesen/dsh-turn-delete) 的**独立延续版**。上游主分支暂未合并本仓库的兼容性修复，因此这里独立维护，并跟进 DeepSeek Harness `0.1.5-rc.2` 的 surface 规则。

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
dsh plugin --profile web add github:TiJun-Prime/dsh-turn-delete-dev
```

从预构建的 GitHub Release 安装（发布 Release 之后可用）：

```sh
dsh plugin --profile web add https://github.com/TiJun-Prime/dsh-turn-delete-dev/releases/latest/download/dsh-turn-delete.tgz
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

## 设计

Host 端注册 `POST /dsh-turn-delete`：取得目标 Agent 的维护租约 → 校验目标轮次是一个完整闭合、且仍可独立删除的 surface 区间 → 追加持久替换事件 → 等待 `sessions.flush()` 完成后才返回成功。

替换事件是一条空内容的 `system/message`，携带 `surfaceOp: { op: 'replace', startSeq, endSeq }` 以及它所遮蔽的 `sourceEventSeqs`。

浏览器端使用公开的 `conversation.chat.assistant-actions` 与 `conversation.chat.turnTail` slot：一个 Conversation definition 把持久 tombstone 投影到目标 Turn 的 Location data 上，标记组件据此隐藏相邻 Turn tail 之间的 Chat 行。DeepSeek Harness 目前还没有公开「整轮可见性」扩展点，所以这层呈现兼容被限制在行范围内；**模型上下文的删除完全不依赖它**。

## 兼容性

- DeepSeek Harness `0.1.5-rc.2`（surface 替换使用 `{ op: 'replace', startSeq, endSeq }`）
- Node.js 22.19 或更高版本
- Web profile 与基于 Web 的桌面套壳

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
