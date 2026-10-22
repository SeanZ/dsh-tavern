# 最后一轮正文编辑

入口：游玩对话底部“更多 → 编辑正文”。仅允许编辑最后一轮非开场正文；生成、后台处理或重生成期间不可保存。

- `<dream_body>`、`<content>`、`<gametxt>` 等叙事协议标签保留原字节，其包裹的文本可编辑；这些标签不按 HTML 容器处理。
- 文本段提供编辑框；原始 HTML 与 HTML 围栏完整保留，不进入编辑框。纯 HTML 回复不可编辑。
- 保存不调用模型、不重新结算、不重放宏或脚本；已有状态、MVU 变量、剧本游标保持不变。旧候选项清空。
- Chat 通过 Story Timeline 的 `body.edit` 意图保存新正文及修订。读取时的版本凭据防止覆盖其他窗口的新正文；展示采样不构成正文冲突。
- 原生 Session 追加合成 assistant replacement，只替换当前正文的 Surface 节点。旧 Event Log 不变。编辑使用独立合成来源，不复用旧模型回复的 reasoning/replay 信息。
- Chat 保存的 `bodyEdit` 记录持有原生事件位置和稳定消息 ID。保存、后续请求前进行幂等同步，恢复 Chat 已落盘而 Session 未落盘的中断。
- 编辑后的正文强制提供展示投影，避免 DSH 历史展示仍渲染旧文本；重生成新正文时清除旧编辑同步标记。

验证：`body-editor.test.mjs` 覆盖分段保真、冲突、状态保留及写入恢复；`body-editor-native.test.mjs` 覆盖存档恢复后的真实 Agent 请求；`fixtures/body-editor-browser-smoke.mjs` 使用正式前端组件与原生 Session 提供独立浏览器验证页面。

## 切换历史结果（故事视图）

RPC `switchFloorResult({ sessionId, turn, replySeq })` 把最新一层换回这一轮的另一次生成（`lib/domain/floor-result-switch.js`）。`replySeq` 取 `story-rounds` 楼层 `history[].seq`。不调用模型：

1. 与重新生成相同的前提：游玩/剧本模式、前台空闲、无重新生成或结算在途、`turn` 必须是存档最后一层（与 `body.edit` 时间线意图「只能编辑最后一轮正文」一致；更早楼层之后已有剧情和结算依赖它，不放宽）。
2. 存档按编辑正文的路径写入：选中生成的原始文本作为 `sourceText`，重新做正则投影（不重放宏），经时间线 `body.edit` 意图更新正文、清候选、让常驻后台参与者回绕。
3. 模型消息面追加一条 replace，覆盖当前正文节点，来源 `{ kind: 'model', provider: 'dsh-tavern', model: 'result-switch', tavernStoryTurn, tavernResultSeq }`；日志只追加。先写存档后写消息面；两次写入之间崩溃时，存档与消息面正文不一致，依靠原生修复按存档文本重写尾部（未单独做崩溃测试，也不像编辑正文那样留 `bodyEdit` 同步标记）。
4. 选中的就是当前结果时不写任何东西（`switched: false`）；切回原结果是又一次切换。
5. MVU：与编辑正文相同，不重放变量结算，本层变量仍是此前正文结算的结果，返回 `mvu: 'stale'`（未切换时为 `'unchanged'`）。需要一致的变量时，用重新生成或手动结算。

返回 `{ switched, turn, replySeq, mvu, view }`，`view` 为会话视图。稳定性：参数与返回字段只加不改。测试见 `tests/floor-result-switch.test.mjs`。
