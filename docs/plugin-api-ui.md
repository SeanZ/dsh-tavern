# 本 fork 故事视图契约

上游通用插件 API 文档已迁移至社区 Wiki；本文件仅保留 trunkbase 的额外故事视图契约。

## 故事视图契约（本 fork）

本 fork（`trunkbase`）为独立的故事视图插件（`dsh-tavern-new-ui`）提供的契约，上游没有。服务端部分（楼层折叠 `lib/story/story-rounds.js`、中断墓碑、楼层快照 RPC）见 `docs/design/transcript-row-plan.md`、`last-round-replacement.md`、`html-in-dsh-messages.md` 末尾小节。

### 故事视图模式：关闭 Tavern 的聊天行渲染（C4）

全局设置 `storyViewMode`（默认关闭）开启后，在主视图为故事或剧本会话时，Tavern 不再注册 `conversation.chat.node` 的 `user` / `assistant-step` 行渲染器和 `conversation.chat.assistant-actions` 的分叉、配图按钮（上游新增的每轮「回退到这一轮」按钮也不显示），也不再监听回复揭示；聊天视图回到宿主原生渲染，留作审计视图。依附聊天行的会话级工作随之停止：撤回/错误行的两个 DOM 投影按聊天行挂载数为 0 不建观察器，聊天行的卡片 iframe 与保留帧不再创建。人物卡脚本运行时、状态栏、侧栏页签照常。输入框 dock 只保留插件按钮与「更多」里的停止后台、撤销撤回与压缩；候选项一组（「生成候选项」按钮、「下一步行动」与「重新生成候选项」面板）不再显示，与故事视图楼层操作、输入框状态条重复的入口也不再显示：「重新生成正文」按钮与面板（`dsh-tavern-regen` 不注册）、失败轮「重新生成本轮」「撤回这条输入」、编辑正文面板，以及「更多」里的编辑正文、回退本轮、恢复全部错误提示。关闭时与上游完全一致。

- 读改：`getTavernSettings` / `updateTavernSettings({ patch: { storyViewMode } })`。变更立即生效，不用刷新；其他标签页经本地缓存同步。
- 本机缓存上次读到的开关值；只有已确认属于游玩组的会话才接管。未知模式保留 Tavern 界面，确认后再切换。
- 统一规则为 `storyViewActive = storyViewMode && isPlay`，游玩组只含 `story` / `script`。`card`、`read`、`one-shot` 及未知模式都保留 Tavern 行与 dock；制卡工作台的 HTML 草图预览、回复 presenter 照常。
- 上游 `watchReply`、`watchWorkStatus` 与 composer slot 保持可用；原生 turn、短期工作状态与浏览器 lease 都不能替代故事轮次、持久化 MVU 回执与服务端互斥。
- 稳定性：键名、默认值与故事、剧本会话的原生审计视图保持兼容；制卡工作台保留上游能力。

### 浏览器服务 `tavernStory`：楼层与楼层操作（C5）

Tavern 在浏览器侧另提供服务 `tavernStory`（`inject: ['tavernStory']`），版本字段 `apiVersion: 1`。楼层操作转调与输入框 dock 相同的请求和流程（`rollbackTurn`、`regenBody`、`replayTurn`、楼层快照 RPC），不另立规则。`sessionId` 即 `gameId`；楼层（floor）是 `subscribeRounds` 给出的对象，`story` 是楼层轮次。

| 方法 | 说明 |
|---|---|
| `sessionMode(sessionId)` | 同步读取 `{ mode, known, isPlay, storyViewActive }`。未知时为 `{ mode: '', known: false, isPlay: false, storyViewActive: false }`，不把空模式猜成故事。`isPlay` 与 `storyViewActive` 由 Tavern 统一计算，消费方不重复维护模式列表 |
| `readSessionMode(sessionId)` | 按需读取轻量会话目录，返回上述快照的 Promise；不加载首楼、不打开存档、不持有 Session |
| `subscribeSessionMode(sessionId, listener)` | 立即回调当前快照，随后随明确的会话模式发布与全局开关变化回调，返回注销函数。新建/打开与真实视图发布的模式优先于迟到的列表响应；注销后不再回调。独立 UI 根据主会话的 `isPlay` 注册或注销故事页签，未知时不注册，已知游玩局之间切换保留页签 |
| `storyViewActive(sessionId)` | 同步读取该会话是否被故事模式接管，等价于 `sessionMode(sessionId).storyViewActive`；全局开关开启且模式属于游玩组时才为真。它与只读取全局开关的 `storyViewMode()` 不同 |
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
- `FloorBody` 复用 Tavern 插件媒体索引、正文锚点与图片操作：未命中锚点的媒体放在文后；快照只保存正文，媒体从当前索引重新渲染，避免重复和旧状态。
- `IllustrateAction` 组件，props `{ sessionId, storyTurn, disabled?, className? }`。使用当前局获准的上游配图器；未安装、局内禁用或不在游玩模式时不显示。调用方用 `disabled` 接入楼层操作锁，不另写配图请求。
- **frame 归属**：Tavern 的消息 frame 在 React 卸载后仍会停放保留（同一局离开前不销毁），以免卡片状态丢失。`FloorBody` 在 `live` 变为假或卸载时释放自己 `owner`（默认每个组件实例一个）名下的 frame，活 frame 数因此等于同时 live 的楼层数。要让同一层在重挂载后接回原 frame，可传固定的 `owner` 对象，并在不再需要时卸载或置 `live: false`。frame 按（会话、楼层、片段序号）复用；Tavern 聊天行也画同一层时（未开启故事视图模式）两者会共用同一个 frame，所以只在故事视图模式下使用。
- `captureFloorSnapshot(element, budget?)` → `{ html, truncated, frames, missed }`：`element` 为 `FloorBody` 的容器（`containerRef`）或单个 iframe。每个 frame 经已有的带预算 DOM 快照通道读取（同源 frame 直接读，沙箱 frame 走 frame 内报告脚本的消息），其余片段读页面 DOM；结果净化同上，超出预算时 `truncated` 为真并带截断标记；读不到的 frame 计入 `missed`（canvas、WebGL 等只能拿到 DOM 结构）。沙箱 frame 的读取也会像诊断快照一样写一份显示运行时记录。
- `StaticHtml`（`{ html }`）、`sanitizeHtml(html)`：同一套净化与 shadow root 显示。

稳定性：同 `tavernStory`。
