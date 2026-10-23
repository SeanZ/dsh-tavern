import { inputKind } from './session-turn-input.js'

// 切换历史结果后 MVU 变量仍对应旧正文（存档 variablesStale）。这时开始新回合，模型会按错误的
// 变量继续写，结算也会叠在错误的基线上；所以新玩家输入在回合开始时就被拒绝，等玩家重新结算或重新生成。
export const STALE_VARIABLES_SEND_ERROR = '变量未重算：请先按当前正文重新结算（或重新生成），再发送'

/**
 * 撤下仍在排队的玩家输入（被拒回合之后的那些）。它们留在队列里会在宿主出错暂停后卡住；
 * 撤下后的文字由故事折叠并入被拒回合的 attempt.inputs，供界面恢复到输入框。
 */
export function dropQueuedPlayerInputs(agent) {
  const inbox = agent && agent.inbox
  if (!inbox || typeof inbox.remove !== 'function') return 0
  const queued = (inbox.nextTurn || []).filter(message => inputKind(message) === 'player')
  for (const message of queued) inbox.remove(message.id)
  return queued.length
}

/**
 * 回合开始前（输入模板与提示构建之前）的检查。只拦新的玩家输入：重新生成、改写的合成输入照常；
 * 非官方 MVU 卡没有这个标记。`isStale(sessionId)` 读存档最新楼层，`agentFor(sessionId)` 给出前台 agent。
 */
export function createStaleVariablesGuard({ isStale, agentFor }) {
  return async function rejectStaleTurn(input) {
    if (!input || input.playerInput !== true) return
    if (!await isStale(input.sessionId)) return
    dropQueuedPlayerInputs(agentFor(input.sessionId))
    throw new Error(STALE_VARIABLES_SEND_ERROR)
  }
}
