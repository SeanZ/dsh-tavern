# 在 DSH 对话中插入 HTML

> 本文只说明接入方式；行为与数据边界以[助手正文 HTML 渲染设计](inline-message-renderer-refactor.md)为准。

## 结论

dsh-tavern 通过 DSH 的 `conversation.chat.node / assistant-step` 正式插槽接管游玩消息，而不是修改页面 DOM，也不把普通回复伪造成工具调用。

展示链路是：

```text
displayText
  → 保持原顺序生成 displayParts
      ├─ Markdown       → DSH MarkdownText
      └─ HTML           → 必要时 marked 编译 → iframe
```

前端围栏包括：

- 标注为 `html` 或 `htm` 的代码围栏；
- 未标注语言，但源码含 HTML 标签或注释的围栏；其中包含 `html>`、`<head>` 或 `<body` 的完整页面与酒馆助手识别方式兼容。

HTML 不要求来自正则。模型原始输出、普通规则或 `markdownOnly` 规则产生的 HTML 都使用同一条展示链路。

这里不再把“原生 HTML”和“前端代码”建模为两种能力。它们都是需要浏览器解释和运行的 HTML；区别只在输入预处理：raw HTML 与周围 Markdown 一起编译，代码围栏先去掉围栏。

## 为什么使用 iframe

人物卡 HTML 可能包含 CSS、JavaScript 和远程依赖。直接放进宿主 DOM 会污染 DSH 样式并获得不必要的宿主能力。iframe 可以让界面出现在正文原位置，同时隔离文档、样式和脚本。

当前 iframe 使用：

```tsx
<iframe
  sandbox="allow-scripts"
  referrerPolicy="no-referrer"
  srcDoc={documentHtml}
/>
```

它允许 HTTPS 远程脚本、样式、图片、子页面和网络请求，以支持 jsDelivr 及社区卡片接口；但不启用 `allow-same-origin`，不提供 Tavern Helper Host bridge，也不允许读取 DSH Session 或宿主 DOM。父页面只接受带随机 token、且来源确为该 iframe 的高度消息。远程 API 如果不允许跨域，`fetch` 仍会被浏览器拒绝。

## 与 Session 的关系

iframe 只消费 `displayText` 的临时投影。DSH Session 保存的是 `sessionText`：

- `markdownOnly` 只改变 UI；
- `promptOnly` 只改变写入上下文的文本；
- 原始输出另存为 `sourceText`；
- iframe 文档、DOM 状态和用户在卡片中的临时操作都不写回 Session。

因此 `【首页】` 可以在 Session 中保持短占位符，而玩家看到正则生成的交互页面。具体来源证据见[酒馆正则渲染备忘](../research/sillytavern-regex-rendering-memo.md)。

## 明确不采用

- 不把 HTML 搬到右侧栏；
- 不扫描并隐藏 DSH 已渲染的 DOM；
- 不让所有 DSH 会话全局开启 raw HTML；
- 不用 HTML 标签形状决定内容所有权；
- 不把 iframe 产物送入模型上下文。

HTML 注释仍按标准浏览器行为不可见。若卡片希望把注释中的数据展示出来，应由自己的显示正则或前端代码明确完成，而不是由 Host 擅自把注释转成可见文本。

## 楼层快照（故事视图）

故事视图只保留最近几层活 iframe；楼层离开活跃窗口时，客户端把脚本执行后的渲染结果去掉脚本与事件属性、样式作用域化后存成静态 HTML，之后向上滚动或冷打开会话直接显示它，不跑脚本。服务端只负责存取（`lib/domain/floor-snapshots.js`）：

- 写入：RPC `saveFloorSnapshot({ sessionId, turn, reply, html, truncated? })`。`turn` 为故事轮；`reply` 是拍摄时这一层正文的来源标识（故事视图用 `story-rounds` 楼层的 `reply.seq`），`html` 不超过 512 KB 字符，超出由客户端截断并置 `truncated: true`。同一来源与内容再次写入不改文件（`saved: false`）；来源变了（重新生成、切换历史结果）覆盖旧快照。返回 `{ saved, snapshot: { turn, reply, truncated, capturedAt } }`。
- 读取：RPC `getFloorSnapshots({ sessionId, turns? })` → `{ snapshots: { [turn]: { turn, reply, html, truncated, capturedAt } } }`。故事视图冷打开时与会话视图并行读取；`reply` 与当前楼层不一致的快照是过期的，忽略即可。
- 存放：与 display-runtime 诊断同理，快照是可重建的显示缓存，存在 Profile 数据目录 `floor-snapshots/<chatId>/<turn>.json`（`version: 1`），不进版本化存档：写快照不增加存档修订、不与正文写入冲突、不触发视图刷新，也不随导出的存档走。每局只留最近 200 层，删除游戏时一并清除。没有该目录的游戏（此前的全部存档）读出空表，无需迁移；未知版本或损坏的文件被忽略。
- 服务端不解析、不执行快照内容；显示时仍由客户端按楼层容器净化与作用域化。

稳定性：两个 RPC 的参数与返回字段只加不改，供 fork 的故事视图插件依赖。测试见 `tests/floor-snapshots.test.mjs`（临时目录上的真实 Profile 存储）。
