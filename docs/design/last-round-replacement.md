# 最后一轮整体替换

> 状态：已实施；回退本轮保持原实现；失败尾部重放见末节。

## 决定

DSH Agent 的 Session 是只追加轨迹，不采用 SillyTavern 的多 Swipe 分支模型。重新生成只允许作用于最后一个已经完成的 Round，并且产生一个唯一替代版本。

一个 Round 包含前台正文和后台状态结算。重新生成时保留原玩家输入，回到该 Round 之前的 checkpoint，依次重新生成正文和状态；两者都成功后，才一次替换 Chat 中的旧 Round 与 DSH Surface 中的旧正文。任何阶段失败，旧 Round 都继续有效。

## 时序

1. 确认不存在运行中或等待结算的 Round，并锁定当前 Chat 的重新生成入口。
2. 校验目标是最后一组玩家输入与助手正文，保存原 Chat 和模型 Surface 边界。
3. 回到该 Round 之前的 checkpoint，在同一前台 Session 中追加内部重新生成任务。
4. 得到新正文后，仅作为候选 Round 暂存，不替换用户可见正文。
5. 使用共享后台 Agent 重新执行状态结算。
6. 结算成功后，提交唯一新正文、状态、checkpoint 和 revision，并把旧正文至临时生成消息的 Surface 连续区间折叠为新正文。
7. 生成或结算失败时恢复原 Chat，并用空插件节点清理本次临时 Surface；原玩家输入与旧正文保持可见。

## 约束

- 不保存多个正文版本，不提供左右 Swipe 切换。
- 不修改已有后续剧情的历史 Round；需要修改时先回退。
- Round 未完成时，禁止下一轮、重新生成和回退。
- Chat/Story Timeline 是权威状态；DSH Surface 和 UI 都是投影。
- DSH 事件历史保持只追加，临时事件可以保留用于追溯，但不会进入后续模型可见上下文。
- 人物卡原始数据中的 `swipes`、`swipeId` 和变量槽位可为兼容读取而保留，不构成产品级分支能力。

## 验收

1. 重新生成成功后，Chat 和模型上下文只包含新正文，不包含旧正文或内部指令。
2. 后台结算失败时，Chat、界面与模型上下文仍保持旧整轮。
3. 连续重新生成始终只有一个当前正文版本。
4. 重生成运行期间不能开始下一轮、再次重生成或回退。
5. 回退既有测试保持通过。

## 失败尾部重放

失败的一轮从未提交为 Round，所以既没有可回退的 checkpoint，也没有可替代的旧正文；把“重新生成”接到整体替换上，只会命中上一条已提交 Round，删掉玩家最新一次输入。因此失败尾部使用独立的恢复路径：

1. 只认领尾部：最后一个 `turn/end` 的 reason 是 `error` 或 `aborted`，且其后再没有 `turn/start`。失败之后又开始了新回合时不再提供重放。
2. 从只追加事件历史里取回该轮的原始玩家输入。失败清理墓碑会替换原生节点，但原始 `user/message` 仍在历史中，`sourceEventSeqs` 只用于定位，不承担输入事实。
3. 复用失败清理：清理钩子已在失败时执行过，重复调用对已清理回合是无操作；钩子缺失时在这里补清。无论哪种情况，模型可见上下文都不再包含被中断的内容。
4. 把该轮计入 `suppressedDshTurns`，客户端据此隐藏残留正文与错误行。
5. 以该轮原始输入的**用户身份**重发同一文本（沿用原 `rpcId` / `clientTimeZone`），走正常前台 prepare/finalize，提交一条新的 Round 并正常排队状态结算。只认领原生用户输入与历史 `dsh-tavern-replay` 输入；`dsh-tavern-regen` 合成输入（含补充意见）不走重放，避免把内部指令当成玩家原文提交。
6. 重发必须保持 `source.kind === 'user'`。宿主 chat UI 只把 `kind` 为 `user` 的 `user/message` 渲染成输入行，其余一律归类为 context 节点（`dsh-client-ui-chat` 的 `messageDefinition.start`）。早期实现用 `{kind:'plugin', plugin:'dsh-tavern-replay'}` 标记来源，结果是：失败轮次的输入被 `suppressedDshTurns` 隐藏、重发的副本又只渲染成不可见的上下文节点——玩家文字在对话里彻底消失（实际 bug）。
7. 重放与重生成、回退互斥：任一进行中时，另外两个入口直接拒绝。

因为失败时被中断的节点已经离开模型消息面，重放请求的前缀与失败前完全一致；只有末尾“本轮注入”需要按当前状态重新渲染，因此绝大部分 prompt 仍可命中供应商缓存。重放不需要意见输入：它恢复的是同一个请求，不是一次改写。

宿主在 v2.1 起把 `regenerate` / `regenBody` / `rollbackTurn` / `rollbackChat` 四个入口都置于会话补丁握手之后；重放同样会改动消息面，因此入口也检查 `sessionPatch.replacementAllowed()`，未握手时直接拒绝。

### 失败尾部重放验收

1. 失败后点击“重新生成本轮”不打开意见面板，直接移除被中断的回复并重发原始输入。
2. 重放产生的请求前缀与失败前一致，不包含半截正文、错误节点或清理墓碑。
3. 已提交的上一条 Round 不被回退、不被替换；重放成功后追加一条新 Round。
4. 清除未完成回复不再使重放失效：可用性只看事件历史里的失败尾部，不看展示状态。
5. 失败后已经有新回合开始、或重放/重生成/回退进行中时，重放被拒绝；重生成合成输入的失败尾部也不提供重放。

## 故事视图模式：中断即打墓碑

全局设置 `storyViewMode`（`tavern-settings.json`，`presentTavernSettings` 读出，默认 `false`；`updateTavernSettings({ patch: { storyViewMode: true } })` 修改）开启时，失败清理钩子 `cleanupFailedTurn` 不再把失败轮留到下一次操作，而在该轮结束时（`turn/end` 原因为 `error` / `aborted` / `interrupted`，游玩或剧本模式）立即清理（`lib/domain/interrupted-round-tombstone.js`）：

1. 范围复用 `planFailedTurnSurface`：按该轮自己的 seq 区间覆盖玩家输入、本轮 frame 上下文（世界书快照、人物卡系统指令更新、前台 frame）与半截正文，写一个 `dsh-tavern-failed-turn-cleanup` 用户墓碑；不用「打断点之后全部」，墓碑落地前到达的新输入与新回合不受影响。
2. 只处理玩家自己的回合：重新生成尝试轮由它自己的中止流程清理；存档已经保存了这一轮（finalize 之后才被中止）或它是某轮的重生成座位时不写。
3. 世界书快照与人物卡系统指令更新的去重读的是模型消息面，墓碑后下一轮会重新下发被废弃回合的快照。
4. 半截正文永不进存档：存档只在宿主 `agent/turn-stopping`（一步正常结束且未中止）时由 finalize 写入；中止的重新生成恢复原存档。
5. 既有失败轮流程不变：重试（`replayFailedTurn`）仍从日志取回原输入、清理为无操作；失败轮编辑走 Chat 覆盖层；下一次发送前的 `clearFailedTurns` 无事可做。注意失败尾部在被处理前仍优先于回退：开关开启时，中断后的第一次 `rollbackTurn` 只结清这条失败尾部（返回 `clearedIncompleteTurns` 与 `clearedInput`），再次调用才回退已提交的一轮，与关闭时的语义相同。

关闭时不写任何东西，行为与上游一致。稳定性：设置键名、默认值与「结束即清理」的语义只加不改，供 fork 的故事视图插件依赖。测试见 `tests/interrupted-round-tombstone.test.mjs`（真实宿主 Session、V4 关系校验与 JSONL 写盘冷读）。
