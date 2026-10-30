# 插件开发：浏览器侧 tavernUi

浏览器侧 `ctx.tavernUi`：显示媒体、正文标记、按钮、面板、舞台与声音。

浏览器侧的代码运行在 DSH 页面里，使用 DSH 提供的 `react`。插件的 `render` 函数返回 React 元素；出错时只影响这个元素，正文其余部分照常显示。

## `registerMediaRenderer(kind, render)`

为插件自定义的 `kind`（`<插件名>/<类型>`）提供显示方式，比如边下载边显示、带播放器的卡片。`image`、`video`、`audio` 由 Tavern 显示，不能替换。

```js
render({ item, gameId, turn })  // item 与 list 返回的字段相同，另有 url（有附件时为附件地址）
```

没有注册显示方式的自定义媒体项不显示。

## `registerTextMarker({ pattern, render })`

正文里匹配 `pattern`（正则）的片段交给插件显示，例如把 `image###…###` 换成图片。生成过程中也会调用，此时 `streaming` 为 `true`。

```js
render({ match, groups, gameId, turn, streaming })  // 返回 React 元素；返回 null 或出错时原样显示这段文字
```

- 普通正文里，标记就地替换。
- 写在人物卡自己的 HTML 界面（状态栏、美化面板）里的标记，无法拆开那段 HTML，会从界面里去掉，显示在那段界面之后。
- 标记仍留在对话历史里，后续轮次模型能看到。是否要求模型继续写，由插件在提示词段落里说明。

## `registerMessageAction({ id, label, when, run })`

在每条已写完的助手消息下方加一个按钮，例如「配图」「重画」。`when(context)` 决定是否显示（不传则总是显示），点击时调用 `run(context)`，`run` 可以是异步函数，执行期间按钮不可再点。

```js
context = { gameId, turn, settled, text }
```

`text` 是这条消息的正文（模型写出的原文），可用来只在合适的消息下显示按钮，例如正文里已经有某个标记时就不显示。

## `registerComposerAction({ id, label, when, run })`

在输入框上方的操作栏加一个按钮，针对当前最新一轮。模型正在生成时按钮不可点。

```js
context = { gameId, turn, busy }
```

想替换内置生图的插件就用这个入口。内置生图的入口在每轮正文下方的操作栏（图片图标），与插件按钮互不占位，由用户选择用哪个。

## `readPluginData()`、`savePluginData(data)`（第 3 版）

读写插件自己的数据，和宿主侧 `tavern.readPluginData()`、`tavern.savePluginData({ data })` 是同一份（见[媒体与数据](plugin-api-data.md)）。都返回 Promise；`savePluginData` 传 `null` 清除。

## `registerIllustrator({ kinds, draw?, redraw?, editPrompt?, add?, cancel?, action? })`（第 5 版）

生图插件接管 Tavern 自己的配图界面：每轮的「为这一轮配图」按钮，以及正文里包住插件图片的插图卡。插图卡负责显示、版本切换、删除、进度和取消按钮，插件只负责出图。`kinds` 是插件自己的媒体类型；这些类型的媒体项由插图卡显示，不再走 `registerMediaRenderer`。

每个处理函数收到 `{ gameId, turn, textVersion, item }`，可以返回 Promise，抛错会显示在卡片上。只提供了哪个函数，卡片上就出现对应的按钮：

- `draw`：为这一轮配图（不提供就没有配图按钮，比如插件的配图功能被关掉时；已有插图照常由插图卡显示），通常 `attach` 一个 pending 占位，出图后 `update` 成 ready。等它返回期间，正文里显示「正在整理画面…」；返回 `{ notice }` 时把说明留在原处几秒（比如「本轮跳过配图：没有合适的画面」），抛错则显示失败原因。不必另弹提示。
- `redraw`：按这张图的提示词再画；新图换上后旧图成为早期版本。
- `revise`：重新整理提示词再画，多收到玩家写的 `instruction`（可能为空，空时重新构思画面）。提供了它，「重画」会打开面板，让玩家在「同提示词重画」（`redraw`）和「按意见重画 / 重新整理提示词」（`revise`）之间选。
- `editPrompt`：「改提示词」，多收到 `prompt`。
- `add`：「新增插图」，多收到玩家写的 `instruction`（可能为空）。
- `cancel`：pending 或 `activity.cancellable` 时的「取消」。
- `action`：媒体项 `actions` 里的按钮，多收到 `actionId`。

插图卡只读标准字段：`status`、`progress`、`error`、`prompt`、`activity`、`actions`，插件自己的 `data` 它不读。

## `listIllustrations()`（第 4 版）

原本列出 Tavern 自带场景生图画过的插图。Tavern 已不再保留这些旧图（配图都由插件生成），现在总是返回空列表；方法保留，旧插件调用不会出错。插件自己挂的媒体请用插件媒体接口读取。

## `getGames(gameIds)`（第 4 版）

按 `gameId` 查游戏名称，返回 Promise `{ [gameId]: { title, cardName } }`；已删除或不存在的游戏不在结果里。一次最多 500 个。

## `callHost(name, args)`（第 2 版）

调用宿主侧用 `tavern.handle(name, handler)` 注册的处理函数，返回一个 Promise，结果是处理函数的返回值。

```js
ctx.tavernUi.registerMessageAction({
  id: 'redraw', label: '重画',
  run: ({ gameId, turn }) => ctx.tavernUi.callHost('dsh-tavern-xxx/redraw', { gameId, turn }),
})
```

处理函数不存在（插件宿主侧没加载、或没注册这个名字）时失败，错误码 `TAVERN_PLUGIN_NOT_FOUND`。

## `assetUrl(path)`（第 2 版）

插件文件夹里 `assets/` 下文件的地址，用于图片、地图、音效、音乐、字体等：

```js
h('img', { src: ctx.tavernUi.assetUrl('map/forest.png') })
new Audio(ctx.tavernUi.assetUrl('sfx/hit.mp3')).play()
```

- `path` 是相对 `assets/` 的路径，不能含 `..` 或以 `.` 开头的部分。
- 只提供 `assets/` 下的文件，插件文件夹里的代码和设置不会被公开；放进 `assets/` 的文件，打开酒馆页面的人都能读到，不要放密钥。
- 音频、视频支持拖动进度（按范围读取）；文件修改后浏览器会重新取。
- 插件按 `package.json` 的 `name` 认出自己（与浏览器侧 `factory` 返回的 `name` 相同）。只对放在 `plugins/` 文件夹里的插件有效。

## `watchState(gameId, name, listener)`（第 3 版）

先用当前的值调用一次 `listener(data)`，之后本插件宿主侧每次 `tavern.publishState` 同一个 `name` 时再调用（内容没变不调用）。没有发布过时收到 `null`。返回取消函数，插件卸载时自动取消。

## `getTurnState(gameId)`、`watchTurnState(gameId, listener)`（第 2 版）

`getTurnState` 返回 Promise，结果与宿主侧 `tavern.getTurnState` 相同。`watchTurnState` 先用当前状态调用一次 `listener(state)`，之后每次状态变化（开始或写完正文、结算开始或结束、回退等）再调用；返回取消函数，插件卸载时自动取消。只在这一局在当前页面打开时有通知。

## `watchReply(sessionId, listener)`（第 6 版）

读正在写的这条回复，**卡片工作台也能用**（其他 `getTurnState` 一类接口在工作台不可用）。先用当前状态调用一次 `listener(state)`，之后每次变化（逐字生成、写完、工具开始或结束、卡片落盘）再调用；返回取消函数，插件卸载时自动取消。只在这一局在当前页面打开时有通知。

```js
const stop = ctx.tavernUi.watchReply(gameId, (state) => {
  bubble.text = state.text
  bubble.streaming = state.streaming
  if (state.cardSaved) showBuiltCard(state.cardSaved)
})
```

| 字段 | 含义 |
|---|---|
| `mode` | `'card'` 是卡片工作台，`'story'` / `'script'` 是游玩 |
| `turn` | 这一轮的轮次（工作台里同样是 DSH 的轮次） |
| `text` | 最新一条助手回复的纯文本；生成中是当前已写出的部分 |
| `streaming` | 正在逐字写（已经拿到部分文字） |
| `busy` | 这一轮还在跑（生成正文或执行工具），此时 `text` 可能还是上一轮 |
| `tool` | 正在执行的工具名（如 `tavern_update_card`），拿不到时 `null` |
| `cardSave` | 工作台最近一次落盘：`{ turn, path, createsCard, changed }`，没有时 `null` |
| `cardSaved` | 这一轮刚创建的新卡路径（`createsCard`），否则 `null` |
| `changed` | 这一轮改过或创建了这张卡（含工具直接保存），否则 `false` |

工具调用不会改动 `text`；想在工作台里判断「建好了」，用 `cardSaved`，不要匹配正文。

## `watchWorkStatus(sessionId, listener)`、`getWorkStatus(sessionId)`（第 7 版）

读这一局现在在做什么，给桌宠、陪玩这类要跟着状态换表情的插件用。`watchWorkStatus` 先用当前状态调用一次 `listener(status)`，之后每次变化再调用，返回取消函数；只在这一局于当前页面打开时有通知。`getWorkStatus` 同步读当前值，不订阅。

```js
const stop = ctx.tavernUi.watchWorkStatus(gameId, (status) => {
  pet.face(status.state) // idle / thinking / working / waiting / success / error
})
```

| 字段 | 含义 |
|---|---|
| `state` | `idle` 空闲；`thinking` 正在写正文；`working` 正在跑工具或后台结算；`waiting` 在等玩家回答（`ask_user_question`）；`success` 刚忙完；`error` 出错 |
| `reason` | 细分来源：`idle` / `busy` / `streaming` / `tool` / `settlement` / `question` / `settled` / `load` |
| `busy` | 这一局现在是否在跑 |
| `turn` | 最新一轮的轮次；还没有正文时为 `0` |
| `tool` | 正在执行的工具名，拿不到时 `null` |
| `phase`、`role` | Tavern 的原始活动字段（`role` 如 `settlement`） |
| `error` | `state === 'error'` 时的原因，否则空字符串 |
| `updatedAt` | 这次状态的生成时刻 |

- `success` 只在**看着这一局从忙变闲**时出现，持续 4 秒后回到 `idle`；第一次订阅一个早就写完的局不会补一次成功。
- 换局、关掉这一局、插件卸载都会自动停掉订阅。
- 只读，不改变游戏。

## `acquireLease({ sessionId, scope, ttlMs?, reason? })`、`getLease(sessionId, scope)`、`watchLease(sessionId, scope, listener)`（第 7 版）

「占用锁」：同一局同一个 `scope` 同时只给一个插件。给桌宠这类会抢气泡、动作、舞台的插件协调用，避免两个插件同时说话或同时换画面。

```js
const lease = ctx.tavernUi.acquireLease({ sessionId: gameId, scope: 'voice', ttlMs: 30000, reason: '引导提问' })
try { /* 这段归我说话 */ } finally { lease.release() }
```

- `scope` 只能用小写字母、数字、点、下划线和连字符，以字母开头；建议用 `voice`、`bubble`、`stage`、`composer` 这类语义名。
- `ttlMs` 默认 30 秒，范围 1 秒–10 分钟。过期是懒判的：`getLease` 和下一次 `acquireLease` 会清掉，`watchLease` 会收到 `expired`。
- 返回 `{ leaseId, holder, expiresAt, renew(ttlMs?), release(), active() }`。`holder` 是插件名（`package.json` 的 `name`）。
- 别人持有这个 `scope` 时 `acquireLease` 抛错，`error.code === 'TAVERN_PLUGIN_LEASED'`，另带 `holder` 与 `expiresAt`；同一个插件重拿是续期，`leaseId` 不变。
- 续期时锁已经丢了，抛 `TAVERN_PLUGIN_LEASE_LOST`；`release()` 是幂等的。
- `getLease(sessionId, scope)` 返回当前持有者快照或 `null`；`watchLease` 先给一次当前值（`cause === 'current'`），之后在 `acquired` / `renewed` / `released` / `expired` 时回调，返回取消函数。
- 插件卸载时自动释放。Tavern 保证同一 `scope` 只有一个持有者；拿不到锁的插件应当自己让路（检查 `getLease` / `watchLease`），Tavern 不会替它改已经注册的界面。

## `registerReplyPresenter({ id, modes, present })`（第 6 版）

让插件把会话里的**已完成**回复折叠成一行，例如卡片工作台里已经由桌宠念过的提问。Tavern 在画每条助手消息时同步调用 `present(message)`；返回 `null` 或不认识就保持原文。

```js
ctx.tavernUi.registerReplyPresenter({
  id: 'question', modes: ['card'],
  present: ({ text }) => parseQuestion(text) ? { fold: { summary: '第 2 题：核心定位是什么？' } } : null,
})
```

- `message = { sessionId, turn, text, changed, streaming }`，`streaming` 恒为 `false`（生成中不调用）。
- 返回 `{ fold: { summary } }` 时，这条消息显示成 `🐾 摘要 · 展开`；`summary` 压成一行、最多 60 字，点击就地展开原文，再点「收起」回到一行。
- `modes` 目前只有 `'card'` 有效；同一会话注册多个时，按注册顺序取第一个返回非 `null` 的。
- `present` 必须同步且快；抛错会记到插件错误里，连续 3 次后这一会话不再调用它。插件卸载后恢复原文。
- 只修改显示，存档里的正文不变。

## `registerComposerSlot({ id, modes, render })`（第 6 版）

在输入框正上方加一块插件自己的界面（与对话栏同宽），给卡片工作台的引导员这类需要常驻的角色用。

```js
ctx.tavernUi.registerComposerSlot({
  id: 'guide', modes: ['card'],
  render: ({ sessionId, busy }) => h(GuideDock, { sessionId, busy }),
})
```

- `render` 返回 React 元素，收到 `{ sessionId, busy }`（`busy` 是这一轮是否在跑）。
- 同一会话只显示一个停靠区（先注册者），`modes` 不符合的会话不显示；插件卸载后移除。
- 高度由内容决定，最高 40vh，超出内部滚动；Tavern 会把输入区上移，不会盖住最新一条消息。
- 出错时只显示一行错误；卡内插件按它那张卡的局生效。

## `setInput({ gameId, text })`、`submitInput({ gameId, text })`（第 2 版）

`setInput` 把文字填进这一局的输入框，不发送，玩家可以改了再发。`submitInput` 直接作为玩家输入发送并生成正文，返回 Promise（提交后完成，不等正文写完；要等结果用 `watchTurnState`）。正在生成时会排在当前这轮之后。这一局没有在当前页面打开时报错。

```js
ctx.tavernUi.submitInput({ gameId, text: '我举盾格挡，然后反击。' })
```

## `openOverlay({ gameId?, render, dismissible?, onClose? })`（第 2 版）

打开一层盖住整个页面的插件界面，适合战斗、地图这类需要大空间的玩法。返回 `{ close }`。

```js
const overlay = ctx.tavernUi.openOverlay({
  gameId,
  render: ({ gameId, close }) => h(BattleScreen, { gameId, onFinish: close }),
  onClose: () => { /* 界面关闭后 */ },
})
```

- `render` 收到 `{ gameId, close }`，返回 React 元素；界面自己负责提供关闭的按钮。
- 按 Esc 关闭；`dismissible: false` 时 Esc 不关闭，只能调用 `close`。
- 关闭时调用一次 `onClose`。插件卸载时界面自动关闭。界面出错时显示一行错误和关闭按钮。

## `registerPanel({ id, title, render })`（第 2 版）

在右侧栏加一页插件自己的面板，比如记忆、锚点或状态一览。玩家从侧栏的「＋」里打开，面板显示在「插件」一组。

```js
ctx.tavernUi.registerPanel({ id: 'memory', title: '记忆', render: ({ gameId, visible }) => h(MemoryPanel, { gameId }) })
```

- `id` 用小写字母、数字、点、下划线和连字符；`title` 1–40 字。
- `render` 收到当前侧栏对应的 `gameId`，返回 React 元素；没有打开游戏时，Tavern 显示提示，不调用 `render`。
- 面板出错时只显示一行错误，不影响侧栏其他页。插件卸载时面板自动移除。

## `registerStartGroup({ title, tabs })`（第 2 版）

把插件自己的几个侧栏页归成一组，显示在侧栏开始页（点「＋」看到的那一页）。不声明时，`registerPanel` 的面板在「插件」组，直接用 DSH `betterSidebar.registerTab` 注册的页在「其他」组。

```js
ctx.tavernUi.registerStartGroup({ title: '叙事锚定', tabs: ['narrative-anchor:settings', 'narrative-anchor:state', 'memory'] })
```

- `title` 1–20 字；`tabs` 1–20 个侧栏页 id，按顺序显示。带 `:` 的是侧栏页的完整 id（`registerTab` 时的 `id`）；不带 `:` 的是本插件 `registerPanel` 的 `id`。
- 插件分组排在 Tavern 自带的「本局」「资料库」「偏好」之后、「插件」之前，按注册顺序。Tavern 自己的页不能移进插件分组；同一页被几个分组声明时只显示在第一个里。
- 列出的页没有注册时不显示；整组都没有可显示的页时，整组隐藏。插件卸载时分组自动移除。

## `registerCardListView({ id, label, render })`（第 2 版）

换一种方式显示人物卡列表，例如按分组排的书架、带更多信息的卡片。「人物卡库」和「选择人物卡 · 开始游玩」两处都会用到。列表上方本来就有 Tavern 自带的「列表 / 宫格」切换，注册后多出一个 `<label>`，用户选哪个，这台浏览器就记住哪个。搜索、分组筛选、批量管理的工具栏（全选、删除、移动分组）仍由 Tavern 显示在列表上方，插件只负责画卡片。

```js
ctx.tavernUi.registerCardListView({
  id: 'grid', label: '宫格',
  render({ place, cards, busy, selecting, isSelected, toggle, open, menu, mention }) {
    return h('div', { className: 'my-grid' }, cards.map(card => h('button', {
      key: card.path, disabled: busy, onClick: () => open(card.path),
      'aria-pressed': selecting ? isSelected(card.path) : undefined,
    }, card.imageUrl ? h('img', { src: card.imageUrl, alt: '' }) : null, card.name)))
  },
})
```

`render` 的参数：

| 字段 | 含义 |
|---|---|
| `place` | `'library'`（人物卡库）或 `'play'`（开始游玩窗口） |
| `cards` | 已按搜索和分组筛选、排好序的卡片：`{ path, name, fileName, imageUrl, script, group, starred, error }`。`imageUrl` 没有封面时为空字符串；`script` 是 `{ title }` 或 `null`；`group` 未分组时为空字符串；`error` 是卡片读取失败的原因，正常时为空字符串 |
| `busy` | Tavern 正在导入、删除等操作，期间不要让用户点卡 |
| `selecting` | 是否处于批量管理 |
| `isSelected(path)` | 批量管理时这张卡是否已选 |
| `toggle(path)` | 批量管理时勾选或取消；不在批量管理时什么也不做 |
| `open(path)` | 等于点内置列表的一行：批量管理时勾选或取消，否则在人物卡库打开详情、在开始游玩窗口开局（读取失败的卡不开局） |
| `menu(path)` | Tavern 自己的「⋯ 移到分组」菜单，可放在卡片角上；开始游玩窗口和批量管理时为 `null` |
| `mention(path)` | Tavern 自己的「@ 在对话中引用」按钮，点了把这张卡引用进卡片工作台的输入框，可放在卡片角上；只在卡片工作台的人物卡库、且不在批量管理时有，其余为 `null` |

- `id` 只能用小写字母、数字、点、下划线和连字符；`label` 1–20 字。
- 某一处不想换（例如只想改人物卡库），对那个 `place` 返回 `null`，那里继续用内置列表。
- 显示出错时自动换回内置列表，错误写进错误提示；切换按钮仍在，用户可以重新选。插件卸载后切换消失，回到内置列表。
- 列多少、每格多大、键盘怎么走、Shift 连选这类交互都由插件自己做；`cards` 的顺序就是内置列表的顺序。

## `registerStatusSection({ id, title, render })`（第 3 版）

在这一局的「酒馆状态」页加一节插件自己的内容，排在 Tavern 自己的各节之后，例如当前场景、好感度、导演状态。和 `registerPanel` 的区别：面板是单独的一页，要玩家从「＋」里打开；状态分节和本局状态放在一起，打开状态页就能看到。

```js
ctx.tavernUi.registerStatusSection({ id: 'scene', title: '当前场景', render: ({ gameId }) => h(SceneSummary, { gameId }) })
```

- `id` 规则同 `registerPanel`；`title` 1–20 字，Tavern 画成这一节的标题。
- 出错时这一节只显示一行错误，状态页其余部分照常。卡内插件的分节只出现在它那张卡的局里。插件卸载时自动移除。

## `registerTurnView({ id, label, render })`（第 3 版）

换一种方式显示**整轮正文**，例如对话气泡、剧本排版。`render` 收到 Tavern 自己渲染好的这一轮正文作 `children`，插件可以在外面包一层、在前后加东西，或者自己重画；正文本身（存档里的内容）不变。

```js
ctx.tavernUi.registerTurnView({
  id: 'bubble', label: '气泡',
  render({ gameId, turn, settled, streaming, greeting, text, lines, children }) {
    if (!settled || !lines.length) return null        // 还在生成、或没有台词标注时用 Tavern 自己的
    return h(BubbleTurn, { lines, text, fallback: children })
  },
})
```

| 字段 | 含义 |
|---|---|
| `turn`、`settled`、`streaming` | 第几轮；是否已写完；是否正在生成（生成中也会调用） |
| `greeting` | 是不是开场白 |
| `text` | 这一轮模型写的原文 |
| `lines` | 这一轮的台词标注（同宿主侧 `getCast` 的 `lines`），还没有时为空数组 |
| `children` | Tavern 自己渲染好的这一轮正文（含人物卡的 HTML 界面、正文标记、插件媒体的位置） |

- 每一轮只由收尾的那一步显示一次，不会重复。
- 注册后默认用插件的样式；「酒馆状态」页出现「正文样式」选择，玩家可以选回内置，这台浏览器记住选择（卡内插件带的样式按卡记住）。插件卸载后回到内置。
- `render` 返回 `null` 或出错时用 Tavern 自己的显示，错误写进错误提示。卡内插件的样式只用于它那张卡的局。

## `getStage(gameId, { count? })`、`watchStage(gameId, listener)`（第 2 版）

舞台要显示的东西：`{ enabled, player, card, background, characters, turns }`。`background` 是人物卡带的主背景图地址，没有时为空字符串。`turns` 是最近 `count` 轮（默认 5，最多 10）的 `{ turn, text, lines }`，`text` 是去掉 HTML 块的正文，`lines` 同宿主侧 `getCast`；`characters` 同宿主侧 `getCastAssets`；`enabled` 是玩家是否打开了「对话头像」。`watchStage` 先回调一次，之后在新的一轮、新的标注、素材变化后再回调，只在这一局在当前页面打开时有效。

## `registerStageView({ id, label, render })`（第 2 版）

换掉舞台的画面：只有全屏舞台使用它。Tavern 保留阅读流程（逐句翻页、自动播放、读到最后一句时的输入框），插件只画场景，例如加背景、镜头、Live2D、特效。

```js
ctx.tavernUi.registerStageView({
  id: 'vn', label: '视觉小说',
  render({ gameId, stage, beats, index, beat, fullscreen, advance, footer }) {
    const who = beat?.kind === 'line' ? stage.characters.find(c => c.name === beat.speaker) : null
    return h('div', { className: 'my-scene', onClick: advance },
      who?.sprites[beat.emotion] ? h('img', { src: who.sprites[beat.emotion] }) : null,
      h('div', { className: 'my-textbox' }, beat?.speaker, beat?.text, footer))
  },
})
```

`render` 的参数：

| 字段 | 含义 |
|---|---|
| `stage` | 同 `getStage` 的返回值 |
| `beats` | 最新一轮拆成的「句」：`{ kind: 'line', text, speaker, emotion, turn }`（标注过的台词所在的一行）或 `{ kind: 'narration', text, turn }`（旁白段落） |
| `index`、`beat` | 当前读到第几句、这一句 |
| `fullscreen` | 固定为 true（仅保留全屏舞台） |
| `advance()` | 翻到下一句，点击场景时调用 |
| `footer` | Tavern 的翻页、自动、退出按钮，请放进插件自己的文字框里 |

- 注册后舞台默认用插件的画面；「舞台设置」出现「舞台样式」选择，玩家可以选回内置，这台浏览器记住选择。插件卸载后回到内置舞台。
- `render` 返回 `null` 或出错时用内置画面，错误写进错误提示。
- 全屏时读到最后一句，Tavern 会在底部 88px 内显示输入框；插件的画面请把这块空出来，别把文字框放在那里。
- 舞台入口只在「舞台设置」里「对话气泡」和「舞台模式」都开着时出现。
- 舞台数据由内置独立导演生成；插件视图只呈现宿主投影，不再附带第二个导演示例。

## `speak({ gameId, speaker?, text, emotion?, narration? })`、`stopSpeech()`（第 2 版）

在当前页面朗读一句，用玩家选的配音渠道和这个人物的声音（浏览器朗读也可以）。返回的 Promise 在读完时为 `true`，被打断、配音关闭或失败时为 `false`。同一时间只读一句，新的一句会打断正在读的；`stopSpeech()` 立即停止。适合插件的舞台画面、自己的面板逐句朗读。

## `playMusic(url | { url, title?, volume? })`、`stopMusic()`（第 2 版）

背景音乐由 Tavern 播放：同一时间一首、循环；传入同一个地址时接着放，换地址时淡入新曲，传空字符串或调 `stopMusic()` 时淡出。玩家在全屏舞台控制栏的「♪ 音乐」开关决定听不听得到（记在这个浏览器里），所有卡的音乐都受这一个开关管。离开这一局（切换、删除对话）或这一局不再显示舞台时，Tavern 会停掉音乐；插件换局后要重新调 `playMusic`。`volume` 为 0–1，默认 0.45。

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
- **frame 归属**：Tavern 的消息 frame 在 React 卸载后仍会停放保留（同一局离开前不销毁），以免卡片状态丢失。`FloorBody` 在 `live` 变为假或卸载时释放自己 `owner`（默认每个组件实例一个）名下的 frame，活 frame 数因此等于同时 live 的楼层数。要让同一层在重挂载后接回原 frame，可传固定的 `owner` 对象，并在不再需要时卸载或置 `live: false`。frame 按（会话、楼层、片段序号）复用；Tavern 聊天行也画同一层时（未开启故事视图模式）两者会共用同一个 frame，所以只在故事视图模式下使用。
- `captureFloorSnapshot(element, budget?)` → `{ html, truncated, frames, missed }`：`element` 为 `FloorBody` 的容器（`containerRef`）或单个 iframe。每个 frame 经已有的带预算 DOM 快照通道读取（同源 frame 直接读，沙箱 frame 走 frame 内报告脚本的消息），其余片段读页面 DOM；结果净化同上，超出预算时 `truncated` 为真并带截断标记；读不到的 frame 计入 `missed`（canvas、WebGL 等只能拿到 DOM 结构）。沙箱 frame 的读取也会像诊断快照一样写一份显示运行时记录。
- `StaticHtml`（`{ html }`）、`sanitizeHtml(html)`：同一套净化与 shadow root 显示。

稳定性：同 `tavernStory`。
