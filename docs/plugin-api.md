# Tavern 插件接口总览

接口版本：**3**

DSH Tavern 把扩展功能交给第三方 **DSH 插件**：文生图、文生视频、配音，以及记忆、叙事锚点这类需要参与提示词和后台结算的功能。Tavern 提供一层稳定的接口：让插件知道「这一轮写完了、写了什么」，把图片或别的内容「挂回这一轮」，并往正文请求和后台结算里**添加**内容。多数是添加类接口，插件出错只会丢掉它自己那一份，游戏照常进行；少数替换类接口（如 `replaceSettlement`）让插件接管某个流程，插件失败时自动退回 Tavern 自己的做法。

## 三条承诺

1. **方便**：插件不需要改 Tavern 源码、不需要读 Tavern 的数据文件、不需要打补丁。
2. **稳定**：接口带版本号，只加不改。Tavern 内部怎么重构，都不影响按本文写的插件。要废弃的东西先标记废弃，至少保留 6 个月。
3. **自由**：挂什么、何时挂、挂几个、用什么模型和服务，全由插件决定。Tavern 只负责显示、和正文版本绑定、回退时隐藏。

反过来，插件也只用本文列出的东西。Tavern 的内部模块、数据目录、内部请求、页面结构都不是接口，随时会变。

## 快速开始

一个插件就是一个文件夹。把它放进 Tavern 数据目录的 `plugins/` 下就会加载，不需要改 Tavern 的任何文件，也不需要打包：

```text
~/.dsh/profile-data/tavern/data/plugins/
└─ dsh-tavern-xxx/
   ├─ package.json   声明宿主侧入口，以及（可选的）浏览器侧
   ├─ index.mjs      宿主侧：用 ctx.tavern
   ├─ client.js      浏览器侧（可选）：用 ctx.tavernUi
   └─ assets/        图片、地图、音效等静态资源（可选），用 tavernUi.assetUrl() 取地址
```

设置了 `DSH_HOME` 时，数据目录在 `$DSH_HOME/profile-data/tavern/data/`。最小示例 [`examples/tavern-plugin-hello`](../examples/tavern-plugin-hello/) 就是这样一个文件夹，整个复制过去即可：宿主侧每轮在第一句话所在段落后挂一张图（先显示「生成中…」再换成图片），浏览器侧把正文里的 `hello###…###` 显示成徽章。把其中的 `drawImage()` 换成你的生图服务，就是一个完整的生图插件。

按「要做什么插件」找写法（配图、记忆、读变量、后台推演、接管结算等），见[常见用法](plugin-recipes.md)。

`package.json` 的写法：

```json
{
  "name": "dsh-tavern-xxx",
  "type": "module",
  "exports": { ".": "./index.mjs", "./client": "./client.js" },
  "dsh": { "client": { "platform": "web", "inject": ["dsh-tavern-plugin"] } }
}
```

- 宿主侧入口必须有（`exports` 的 `"."`，或 `main`）。只做界面的插件也要放一个空的 `index.mjs`（`export function apply() {}`）。
- 没有浏览器侧时，去掉 `"./client"` 和整个 `dsh` 字段。
- 插件名建议叫 `dsh-tavern-xxx`，方便用户辨认；不能和已安装的包同名（例如 `dsh-tavern-plugin`），否则会被跳过。
- 插件被删除或卸载时要释放的东西（定时器、连接），用 `ctx.effect(() => () => { /* 清理 */ })` 注册。

浏览器侧的 `client.js` 由浏览器直接加载，不需要打包，固定写成下面的样子；`id` 必须和 `package.json` 的 `name` 一致，React 用 `require('react')` 取：

```js
window.__ModuleLoader__.load({
  id: 'dsh-tavern-xxx',
  factory: (require) => {
    const React = require('react')
    return {
      name: 'dsh-tavern-xxx',
      inject: ['tavernUi'],
      apply(ctx) { /* ctx.tavernUi.registerTextMarker(...) 等 */ },
    }
  },
})
```

什么时候生效：

| 操作 | 生效方式 |
|---|---|
| 往 `plugins/` 放进一个新插件 | 不用重启：宿主侧几秒内加载，浏览器侧刷新一次页面后出现 |
| 修改 `client.js` | 不用刷新：几秒内自动换成新代码 |
| 修改 `index.mjs` | 要重启 DSH |
| 删除插件文件夹 | 宿主侧不再加载；刷新页面后浏览器侧消失 |

Tavern 把 `plugins/` 下的插件登记在 DSH 的 Tavern 配置（`~/.dsh/profiles/tavern/cordis.patch.yml`）里，以 `tavern-user-plugin-` 开头的条目由 Tavern 自动维护，不要手改。插件文件夹缺 `package.json` 或宿主入口时会被跳过，原因写在 Tavern 日志里。Tavern 通过插件文件夹里自动生成的 `.tavern-entry.mjs` 加载宿主侧：插件代码有语法错误、导入失败或 `apply` 抛错时，只在日志里记一条「plugins/<文件夹> 加载失败 / 启动失败」，不会让 DSH 起不来。这个文件不要改，也不用提交到插件仓库。

写好之后怎样发布，才能让别人在设置里一键安装，见[发布与一键安装](plugin-publishing.md)。

> 不要把插件放进 `tools/` 和 `tools.cordis.yml`：那里是卡片工作台的自创工具，挂在 Agent 预设里，要等第一局开始才加载，浏览器侧也永远不会加载。

### 卡内插件

插件也可以放进 DSH 人物卡（`.dshcard`）的 `plugins/<文件夹>/` 随卡分发，写法和上面的插件文件夹完全一样，并在卡的 `dsh.json` 里登记（见[格式设计](design/dsh-card-format.md)）：

- 导入卡时插件随卡启用：Tavern 把它放进 `plugins/` 加载（宿主侧几秒内生效，浏览器侧刷新页面后生效）。人物卡库的卡片详情里可以随时停用、再启用。
- **只在这张卡的局里生效**：别的局里，它注册的回调不触发、提示词与结算内容不加入、界面（面板、舞台画面、正文标记、按钮）不出现；带别的局的 `gameId` 或别的卡的 `card` 调用接口会被拒绝；`listCards` 只看得到本卡。
- `package.json` 的 `name` 就是插件名，模块导出的 `name` 要与它一致；同名插件同时只能启用一个（同一张卡导入了两份时，只能启用其中一份的插件）。
- 删除人物卡时，卡内插件一起删除。
- 卡内插件在本机运行代码，权限和普通插件一样，Tavern 只能在插件接口这一层限制它。

## 怎么拿到接口

Tavern 向 DSH 注册了两个服务，插件用 DSH 自带的 `inject` 拿：

| 服务名 | 在哪边 | 用来做什么 |
|---|---|---|
| `tavern` | 宿主（Node） | 监听轮次、读正文与设定、挂媒体、往正文请求和后台结算里加内容、读写人物卡库与 Skill |
| `tavernUi` | 浏览器 | 自定义媒体的显示方式、正文标记、消息按钮、输入框按钮、侧栏面板、全屏界面、替玩家输入、人物卡列表的显示方式、舞台画面、整轮正文的显示方式、酒馆状态里的插件分节、朗读 |

```js
export const name = 'my-image-plugin'
export const inject = ['tavern']

export function apply(ctx) {
  if (ctx.tavern.apiVersion < 2) return  // 用到第 2 版的接口时
  ctx.tavern.onTurnSettled(async (turn) => { /* ... */ })
}
```

两条规则：

- **用 `ctx.tavern.方法名()` 的形式调用**，不要把方法单独取出来（`const { attach } = ctx.tavern` 会报错）。Tavern 靠调用方式认出是哪个插件，从而让各插件只能看到、修改自己的内容。
- **注册类的方法（`onTurnSettled`、`onTimelineChanged`、`promptSection`、`turnSection`、`settlementSection`、`settlementTool`、`worldbookSource`、`register…`）在插件卸载时自动撤销**，也会返回一个撤销函数，可以提前调用。

## 基本概念

| 名词 | 含义 |
|---|---|
| `gameId` | 一局游戏。等于 DSH 的会话编号。 |
| `turn` | 轮次编号，开场白是第 1 轮，玩家的第一轮是第 2 轮。编号只增不减：回退后重新生成的正文用新编号，所以编号可能不连续；被回退的轮次读不到，撤销回退后恢复。区分同一轮的不同正文请用 `textVersion`。 |
| `textVersion` | 这一轮正文的某个版本。重写、编辑、切换版本、回退后重新生成，都会得到新的 `textVersion`。不透明字符串，不要解析。 |
| 媒体项 | 插件挂到某个 `textVersion` 上的一样东西：图片、视频、音频，或插件自定义的类型。 |

**绑定规则**：媒体项只在它绑定的 `textVersion` 是当前显示的版本时出现。回退或切到别的版本时隐藏，切回来又出现。Tavern 不会因为回退而删除媒体项。

## 接口分页

| 页面 | 内容 |
|---|---|
| [读取游戏](plugin-api-game.md) | 回合写完、读正文与人物卡、历史、时间线变化、改最新一轮 |
| [正文、结算与任务](plugin-api-prompt.md) | 往正文请求、世界书、后台结算、候选、压缩里添加内容；结算任务、手动任务、`runTask`、`handle` |
| [媒体与数据](plugin-api-data.md) | 挂图片等媒体、按轮与整局数据、插件数据、本局配置项、插件在哪些局生效 |
| [人物卡、Skill 与演出](plugin-api-cards.md) | 人物卡库、改卡、Skill、台词标注、角色素材 |
| [浏览器侧 tavernUi](plugin-api-ui.md) | 显示媒体、正文标记、按钮、面板、舞台、配音与音乐 |

## 插件自建 Agent 的请求记录

插件用 DSH 的 `agents` 服务为某局游戏建子 Agent 时（例如自己做结算），只要创建时把 `meta.parentSession` 设为这局的 `gameId`，这个 Agent 发出的模型请求就会自动记进这局的请求记录：作为后台请求，归在当时最新的一轮，和 Tavern 自己的请求一样只保留最近 30 轮原文。在该子 Agent 的会话里打开「完整上下文」即可查看。插件不需要调用任何接口，也不要自己写 Tavern 的请求记录文件。

Tavern 只给顶层会话（玩家的游戏会话）加回合上下文和「【酒馆状态】」这类提示；带 `parentSession` 的子 Agent 会话一律不加，插件 Agent 收到的只有插件自己给的内容。

## 故事视图契约（本 fork）

本 fork（`trunkbase`）为独立的故事视图插件（`dsh-tavern-new-ui`）提供的契约，上游没有。服务端部分（楼层折叠 `lib/domain/story-rounds.js`、中断墓碑、楼层快照 RPC）见 `docs/design/transcript-row-plan.md`、`last-round-replacement.md`、`html-in-dsh-messages.md` 末尾小节。

### 故事视图模式：关闭 Tavern 的聊天行渲染（C4）

全局设置 `storyViewMode`（默认关闭）开启后，Tavern 不再注册 `conversation.chat.node` 的 `user` / `assistant-step` 行渲染器和 `conversation.chat.assistant-actions` 的分叉、配图按钮，也不再监听回复揭示；聊天视图回到宿主原生渲染，留作审计视图。依附聊天行的会话级工作随之停止：撤回/错误行的两个 DOM 投影按聊天行挂载数为 0 不建观察器，聊天行的卡片 iframe 与保留帧不再创建。人物卡脚本运行时、状态栏、侧栏页签照常。输入框 dock 只保留插件按钮与「更多」里的停止后台、撤销撤回与压缩；候选项一组（「生成候选项」按钮、「下一步行动」与「重新生成候选项」面板）不再显示，与故事视图楼层操作、输入框状态条重复的入口也不再显示：「重新生成正文」按钮与面板（`dsh-tavern-regen` 不注册）、失败轮「重新生成本轮」「撤回这条输入」、编辑正文面板，以及「更多」里的编辑正文、回退本轮、恢复全部错误提示。关闭时与上游完全一致。

- 读改：`getTavernSettings` / `updateTavernSettings({ patch: { storyViewMode } })`。变更立即生效，不用刷新；其他标签页经本地缓存同步。
- 本机缓存上次读到的值，开启状态下打开页面不会先挂上 Tavern 行再撤下。
- 设置是全局的：开启后卡片工作台会话的聊天行也是宿主原生（没有 HTML 草图预览）。
- 稳定性：键名、默认值与「开启即不注册上述三类条目」只加不改。

### 浏览器服务 `tavernStory`：楼层与楼层操作（C5）

Tavern 在浏览器侧另提供服务 `tavernStory`（`inject: ['tavernStory']`），版本字段 `apiVersion: 1`。楼层操作转调与输入框 dock 相同的请求和流程（`rollbackTurn`、`regenBody`、`replayTurn`、楼层快照 RPC），不另立规则。`sessionId` 即 `gameId`；楼层（floor）是 `subscribeRounds` 给出的对象，`story` 是楼层轮次。

| 方法 | 说明 |
|---|---|
| `subscribeRounds(sessionId, listener)` | 用本页事件窗口（`ctx.sessions.binding(sessionId).eventSource`）按 `story-rounds.js` 折叠，立即及每次楼层或生成尝试变化时回调 `{ floors, abandoned, open, attempt, interrupted, settling, staleVariables, receipts, settlement, hasMore, from }`，返回取消函数。`receipts` 与 `settlement` 见表后说明，它们变化时也会回调。`settling` 为真表示最新楼层的后台结算（变量、姿态等）仍在等待或运行（Tavern 视图的 `activity`，与插件 `readActivity` 的 `settling` 同一判定），此时重新生成、改写、切换历史结果、编辑正文与创建分支都会被拒（客户端前置报「正在结算，稍候再试」），界面可据此预先禁用；它变化时也会回调。`staleVariables` 为 `{ turn, replySeq }` 或 `null`：官方 MVU 卡的最新楼层切换历史结果后，变量仍对应切换前的正文（存档在该层消息上记 `variablesStale`，Tavern 视图顶层 `staleVariables`），刷新、重开与从该层创建分支后仍在；按此正文重新结算成功（结算中与失败时保留）、重新生成或改写落定、撤回该层后变为 `null`；手动编辑正文不重算变量，已有标记仍保留，变化时回调。界面据它显示「变量未重算」与 `resettle` 入口，不要只依赖 `switchResult` 的返回值。运行中玩家回合的 `open.liveText` 是已到达的助手正文纯文本（宿主临时条目 `assistant/live-chunk` 的 text-delta，按当前尝试拼接，不含思考；未经正则与 HTML 处理），没有时为空串；只有它变化时最多每 100 ms 回调一次，不重新折叠楼层，正文落定后清空并由 `open.reply` / 楼层接替。重新生成尝试轮在正文落定前没有 `open`，不提供预览。加载更早历史后重新折叠。只覆盖已加载的窗口（`hasMore` 为真时用会话的 `loadOlder()` 往前读）。会话须已在本页打开 |
| `listResults(sessionId, storyTurn)` | 这一层模型每次生成的原文 `{ seq, turn, text, current }`（旧到新；投影、重写正文、编辑不另算；`current` 为当前显示的那次，切换过时按切换目标），没有该层时为 `null` |
| `switchResult(sessionId, storyTurn, replySeq)` | 只用于最新楼层、前台空闲时：改为显示 `listResults` 里 `seq` 为 `replySeq` 的那次生成（服务端 `switchFloorResult`）。返回 `{ switched, turn, replySeq, mvu, resettle, view }`；`mvu` 为 `'stale'` 时变量仍对应切换前的正文；`resettle` 为真（MVU 卡且变量过期）时可用 `resettle` 按新正文重算变量；同一状态也持久地出现在 `subscribeRounds` 的 `staleVariables` |
| `forkAt(sessionId, storyTurn)` | 以这一层**当前显示的正文**为起点新开一局（任意已落定楼层，含开场），之后的楼层、输入与变量变化都不带过去；分叉点包含该层已落定的重新生成、结果切换与编辑。走与聊天行分叉按钮相同的流程（侧栏原生分叉、绑定存档、命名「… · 分支」并打开新局），服务端为 `prepareFloorFork` / `forkFloor`。生成中（窗口里有未结束的回合或尝试）或该层不在已加载窗口时不发请求；运行中、重新生成中、后台结算中由服务端拒绝。新局打开后 resolve `{ sessionId, chatId, turn, replySeq }`，失败时 reject 原因。新局带走该层及之前的楼层快照；MVU 变量是该层结束时（之后切换过结果则为切换时）的存档变量 |
| `rollbackTo(sessionId, storyTurn)` | 删除这一层及之后各层（从最新一层逐层回退）；尾部有失败回合时先结清它。返回 `{ view, rolledBack, clearedInput, input }`；`input` 为被删除的这一层自己的玩家输入 `{ text }`（多条时按行拼接），供界面放回输入框，该层不在本页已加载窗口或没有输入（开场）时为 `null`。dock 的「撤销撤回」只恢复最后一步，跨多层撤回后只能找回最后删掉的那一层 |
| `regenerate(sessionId, storyTurn)` / `regenerateWithGuidance(sessionId, storyTurn, guidance, { restyle?, styleGuidance? })` | 只用于最新楼层：干净重采样 / 按要求改写。与 dock「重新生成正文」同一流程，共用进行中保护和引导记忆；`guidance(sessionId)` 读上次的引导 |
| `editReply.get(sessionId, storyTurn)` / `editReply.save(sessionId, storyTurn, { token, texts })` | 只用于最新楼层、前台空闲且不在结算时：编辑这一层的正文文字（与 dock「编辑正文」同一流程，服务端 `getBodyEdit` / `saveBodyEdit`）。`get` 返回 `{ token, turn, parts }`，`parts` 为 `{ kind: 'text', text }` 或只标类型的 `{ kind: 'html' \| 'marker' }`；`save` 的 `texts` 按顺序对应每个文本片段（HTML 原样保留，不能新增 HTML），返回 `{ view }`。之后模型看到改后的正文；变量不重新结算。正文或会话在两步之间变化时服务端拒绝（「请重新打开编辑」） |
| `editInput(sessionId, storyTurn, text)` | 只用于最新楼层（前置校验同 `regenerate`）：把这一层的玩家输入改成 `text`（服务端 `getBodyEdit` / `saveBodyEdit` 的 `role: 'user'`：消息面 replace 原输入、存档文字同步）。回复不变；要按新输入重写回复，随后调用 `regenerate`，它的合成输入取改后的存档文字，旧输入不再进入请求。返回 `{ view }` |
| `resettle(sessionId, storyTurn, { guidance? }?)` | 只用于最新楼层（前置校验同 `regenerate`）：按这一层当前显示的正文重新做后台结算（服务端 `retrySettlement`，与状态页签「重试后台结算」、聊天行回执「重新结算变量」同一请求）。`guidance` 是只对这次结算生效的指导意见（字符串，≤ 4000 字，可为空串）；省略第三个参数或不带 `guidance` 时服务端沿用上次的指导意见；等待中的结算只能重新投递，带指导意见会被服务端拒绝。MVU 卡从该层结算前的变量快照重算变量；非 MVU 卡只有结算失败时才可重试，否则服务端拒绝并说明原因。结算排队后 resolve `{ view }`，之后 `settling` 为真直到结算完成 |
| `retryFailed(sessionId)` | 用原输入重放失败或被停止的最新回合 |
| `interruptQueued(sessionId, turn)` | 故事视图模式下，打断指定的**原生回合**并继续已有排队输入。`turn` 是 `open.turn` 的正整数；只有对应回合仍运行且队列非空才执行，返回 `{ interrupted: boolean }`。保留消息 ID、附件和 FIFO 顺序；过期回合、空闲或非故事局返回 `false`。当前宿主 `cancel({ keepInbox: true })` 只暂停队列，不能直接代替此契约 |
| `readInterruptedInput(sessionId)` | 失败或被打断、玩家尚未继续时，那一轮的原输入 `{ seq, turn, text, reason }`，否则 `null`（同 `subscribeRounds` 的 `interrupted`）。`abandoned` 里 `reason: 'superseded'` 的回合（被打断后下一轮已认领玩家输入，如 `interruptQueued` 的自动打断）不算，下一轮早期失败时由 `attempt` 报告那一条 |
| `writeFloorSnapshot(sessionId, floor, { html, truncated? })` / `readFloorSnapshots(sessionId, floors)` / `readFloorSnapshot(sessionId, floor)` | 楼层静态快照存取；以 `floor.reply.seq` 作为来源，读回时丢弃来源不符的旧快照 |
| `storyViewMode()` / `setStoryViewMode(boolean)` / `subscribeStoryViewMode(listener)` | 读改 C4 设置 |
| `render` | 楼层渲染运行时，见下节 |

`attempt` 是已加载事件窗口内的最新生成尝试，字段为 `{ turn, seq, phase, inputs, accepted, error, regenerating? }`，没有尝试时为 `null`。重新生成（含按要求改写）发起的尝试轮带 `regenerating: true`，它的失败由发起操作的一方报告，不是玩家自己的回合。`phase` 在输入模板准备时为 `preparing`，模型步骤开始后为 `generating`，结束后为原生 `turn/end.reason.kind`；`error` 为结束事件的错误消息。`inputs` 只取宿主为本轮认领的那条排队输入（`turn/start` 之后的认领 splice），仍在排队的后续输入不计入；在 `user/message` 写入后由正式输入替换，避免重复。`accepted` 表示已有正式用户消息；未接纳输入的早期失败不会生成楼层，也不能用 `retryFailed` 回放。此时界面可显示错误并将已知文字恢复到输入框，不自动重发。窗口没看到本轮那条输入的入队事件时，`inputs` 为空，不会错拿别的排队输入。未接纳就以 `error` 结束的尝试，准备阶段被撤下的排队玩家输入会接在 `inputs` 后面（见下段）。

发送防御：官方 MVU 卡的最新楼层标着变量未重算（`staleVariables` 非 `null`）时，服务端在新玩家回合开始时（等后台结算完成之后、输入模板与提示构建之前）拒绝本轮：该轮以 `error` 结束，`attempt.error` 为「变量未重算：请先按当前正文重新结算（或重新生成），再发送」，`accepted` 为假，不发模型请求、不写正式用户消息；仍在排队的玩家输入一并撤下（不会在宿主出错暂停后卡在队列里），它们的文字与被拒的那条按顺序都在 `attempt.inputs` 里，界面用「编辑」恢复到输入框后再发送。刚点的重新结算若在这轮准备期间成功，标记已清除，这一轮照常进行。重新生成、按要求改写的合成输入，以及重新结算、编辑、撤回、分支等不开新玩家回合的操作不受影响；非 MVU 卡没有这个标记。界面可在 `staleVariables` 非空时预先提示，但不要只靠界面拦截。

`receipts` 是已加载楼层的 MVU 变量回执，按故事轮号（`floor.story`）为键，没有回执的楼层不出现（非 MVU 卡与开场通常为空对象）。来源是 Tavern 视图 `mvuReceipts`（与聊天行回执同一份数据，只做展示投影，不新算）：视图只保留值得注意的回执（pending、error、interrupted、partial、stale）和最近 3 条普通回执，更早的普通楼层没有回执。每条为 `{ status, changes, sideEffects, failures, summary, diagnostics, counts }`：
- `status`：`pending`、`updated`、`partial`、`error`、`stale`、`interrupted`、`unchanged` 之一，未知值按 `unchanged`。
- `changes` / `sideEffects`：`[{ path, operation, before, after }]`，分别是本轮变量操作对应的变化与人物卡脚本联动；路径为 `/delta_data`、`/display_data`、`/schema` 及其子路径的镜像与维护项不列出（同聊天行回执）。`before` / `after` 只给展示字符串：不超过 120 字原样（对象与数组为 JSON 文本），更长的数组给 `[n 项]`，更长的对象给前 5 个键与键数，其它截断到 120 字并以 `…` 结尾；不存在为 `（不存在）`。`path` 截断到 200 字，`operation` 到 20 字。
- `failures`：`[{ path, operation, message }]`；`path` 缺失时用失败的命令文本。`message` 截断到 500 字，空为「未知错误」。
- `summary`：原因说明（≤ 500 字），可为空串。`diagnostics`：`error` / `partial` 时运行时最后 3 条 warn/error 消息（各 ≤ 500 字），否则为空数组。
- 每组最多 50 条；`counts: { changes, sideEffects, failures }` 是过滤镜像路径后的总数，界面显示「n 项」用它。
- 其它回执字段（诊断 ID、计划、提交记录等）不透出。

`settlement` 是最新楼层后台结算的状态 `{ status, turn, error }`，Tavern 视图未读到时为 `null`。`status` 为 `running`（等待或运行中，与 `settling` 同一判定）、`error`（失败或因重启中断，视图 `settleStatus: 'error'`）或 `idle`；`turn` 为视图 `settlementTurn`（最新正文的故事轮，没有时为 `null`），重试只能针对它；`error` 只在 `error` 时给出（视图 `settleError`，≤ 500 字，缺省「后台结算失败，请重试。」）。`settling` 保留作兼容。

兼容性：`receipts`、`settlement` 与 `resettle` 的第三个参数都是新增，旧调用方式与字段不变，`apiVersion` 仍为 1。

稳定性：方法名、参数与返回字段只加不改；不兼容的改动提高 `apiVersion`。

### 楼层渲染：`tavernStory.render`（C7）

`tavernStory.render` 按 Tavern 聊天行的方式画一层故事正文，供故事视图插件使用。宿主是 React，这里直接导出 React 组件。

- `projectFloor(sessionId, storyTurn)` → `{ storyTurn, mode, projection, parts, hasScript, helperContext, frameSizing, trustedCardMode, latestTurn, waitingForHistory }`：该层正则/美化后的投影（与聊天行相同的 `replyProjections`）、Helper 上下文与运行策略。`waitingForHistory` 为真时该层在 Tavern 历史窗口外，用 `loadOlderProjections(sessionId)` 往前扩一页。
- `readInputTemplate(sessionId, inputTurn)` → 玩家输入的显示模板 HTML 或 `null`（`inputTurn` 是输入所在的原生轮次，即楼层 `inputs[].turn`；改过的输入不再用模板）。用 `StaticHtml` 显示。
- `FloorBody` 组件，props `{ sessionId, storyTurn, live?, snapshotHtml?, eager?, owner?, revision?, containerRef?, fallbackText? }`。`live` 时与聊天行一样用 Tavern 的消息 frame 运行卡片 HTML；否则显示 `snapshotHtml`，没有快照时显示投影文字和去掉脚本的 HTML。没有投影且不在等待历史时，用 `fallbackText`（通常为 `floor.reply.text`）显示配色 Markdown。原文、静态 HTML 和快照中的对白与斜体均使用主题配色，保留卡片显式颜色。静态 HTML 按白名单重建（常见排版、列表、表格、标题、链接、details、style、惰性的 button/input/progress 等元素与 class/style/title/src/href/data-*/aria-* 等属性；src/href 只允许 http(s)、相对路径与 data:image；未知元素只留文字与允许的子节点；svg、math、script、iframe、form 等整段移除；样式里的 @import、expression、behavior、-moz-binding 和脚本或非图片 url 剥掉），放在 shadow root 里，`html`/`body`/`:root` 样式改为作用于楼层。`revision` 建议传 `floor.reply.seq`。
- **frame 归属**：Tavern 的消息 frame 在 React 卸载后仍会停放保留（同一局离开前不销毁），以免卡片状态丢失。`FloorBody` 在 `live` 变为假或卸载时释放自己 `owner`（默认每个组件实例一个）名下的 frame，活 frame 数因此等于同时 live 的楼层数。要让同一层在重挂载后接回原 frame，可传固定的 `owner` 对象，并在不再需要时卸载或置 `live: false`。frame 按（会话、楼层、片段序号）复用；Tavern 聊天行也画同一层时（未开启故事视图模式）两者会共用同一个 frame，所以只在故事视图模式下使用。
- `captureFloorSnapshot(element, budget?)` → `{ html, truncated, frames, missed }`：`element` 为 `FloorBody` 的容器（`containerRef`）或单个 iframe。每个 frame 经已有的带预算 DOM 快照通道读取（同源 frame 直接读，沙箱 frame 走 frame 内报告脚本的消息），其余片段读页面 DOM；结果净化同上，超出预算时 `truncated` 为真并带截断标记；读不到的 frame 计入 `missed`（canvas、WebGL 等只能拿到 DOM 结构）。沙箱 frame 的读取也会像诊断快照一样写一份显示运行时记录。
- `StaticHtml`（`{ html }`）、`sanitizeHtml(html)`：同一套净化与 shadow root 显示。

稳定性：同 `tavernStory`。

## 暂时没有的

下面这些目前还没有接口，不代表不能开放。有实际需要时请提[插件接口需求](https://github.com/flizzywine/dsh-tavern/issues/new?template=plugin-api.yml)，写清要做的插件和卡在哪一步，能开放的会按需补上。

- 修改更早的轮次（`setVariables`、`editTurn` 目前只改最新一轮）。
- 直接使用 Tavern 自己的常驻后台会话：它带着整局的结算历史，插件任务混进去会影响之后的结算。需要游戏背景的后台工作请用 `runTask`。
- 替换 Tavern 的其他流程（提示词组装、世界书召回、候选、压缩、MVU 变量结算）。替换类接口会约定插件要交回的结果，插件失败时退回 Tavern 自己的做法。

直接读写 Tavern 的数据目录和人物卡文件不属于接口：这些文件的格式会随版本变化，插件这样做，Tavern 一更新就可能失效。需要里面的数据，请按上面的方式提需求，由 Tavern 提供读取接口。

## 用 DSH 自带的

- 插件设置页：用 DSH 的设置区（`settings.section`）。
- 模型调用、凭据、附件存储：用 DSH 的 `llm`、`credentials`、`attachments` 服务。

## 已知限制

- 修改插件的宿主侧代码（`index.mjs`）后要重启 DSH 才生效。这是 DSH 的机制。
- 开场白不触发 `onTurnSettled`。

## 缺接口怎么办

Tavern 尽量开放接口，并保持每个接口简单、稳定；接口按插件实际用到的内容补充，实在不能开放的会说明原因。现有接口和 DSH 自带的服务都做不到时，请提一个[插件接口需求](https://github.com/flizzywine/dsh-tavern/issues/new?template=plugin-api.yml)，写清要做的插件、卡在哪一步、试过什么办法。请不要靠改 Tavern 源码或读 Tavern 数据文件绕过去，那样 Tavern 一更新插件就会失效。

