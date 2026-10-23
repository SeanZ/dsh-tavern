import { sessionEvents } from './session-events.js'

// Fork and illustration buttons are keyed by the reply the player actually sees.
// A turn may write several model messages (tool step, reply, projection), and the
// visible one is not reliably the last (#234), so every model message of a
// completed native turn maps to it. Projections are often written after the chat
// revision, so this must be derived from session events on every view, never
// from the revision-cached chat projection.
// Regenerated rounds map their new native turn back to the story turn that the
// fork request expects. Superseded or rolled-back replies are not rendered, so
// extra entries are harmless; the server validates every fork request again.
// Earlier turns lose their history after save maintenance (only the latest
// FORK_HISTORY_TURNS turns stay forkable), so they get no fork button.
export const FORK_HISTORY_TURNS = 50
export function forkTurnsByMessageId(session, regeneratedDshTurns = {}, plan = null) {
  const storyByNative = new Map()
  for (const [story, native] of Object.entries(regeneratedDshTurns || {})) {
    if (Number.isSafeInteger(Number(story)) && Number.isSafeInteger(Number(native))) storyByNative.set(Number(native), Number(story))
  }
  const regeneratedStories = new Set(storyByNative.values())
  const replies = new Map()
  const completed = new Set()
  for (const event of sessionEvents(session)) {
    const turn = Number(event.data?.turn)
    if (!Number.isSafeInteger(turn) || turn < 1) continue
    if (event.type === 'turn/start') { replies.delete(turn); completed.delete(turn) }
    else if (event.type === 'assistant/message' && event.data?.message?.source?.kind === 'model' && event.data.message.id) replies.set(turn, [...(replies.get(turn) || []), event])
    else if (event.type === 'turn/end' && event.data?.reason?.kind === 'completed') completed.add(turn)
  }
  const result = {}
  for (const [native, messages] of replies) {
    if (!completed.has(native)) continue
    for (const event of messages) {
      const explicit = Number(event.data.message.source.tavernStoryTurn)
      const planned = plan?.turns && (plan.from == null || native >= plan.from)
      const row = planned ? plan.turns[String(native)] : null
      // 替换事件的 ID 也可能成为宿主按钮目标；其故事身份不等于编辑轮号。
      if (event.surfaceOp?.op === 'replace' && Number.isSafeInteger(explicit) && explicit > 0) {
        result[String(event.data.message.id)] = explicit
      } else if (planned) {
        if (row?.reply !== 0) result[String(event.data.message.id)] = Number(row?.story ?? native)
      } else if (Number.isSafeInteger(explicit) && explicit > 0) {
        result[String(event.data.message.id)] = explicit
      } else if (storyByNative.has(native) || !regeneratedStories.has(native)) {
        result[String(event.data.message.id)] = storyByNative.get(native) ?? native
      }
    }
  }
  const latest = Math.max(0, ...Object.values(result))
  for (const [messageId, turn] of Object.entries(result)) if (turn <= latest - FORK_HISTORY_TURNS) delete result[messageId]
  return result
}
