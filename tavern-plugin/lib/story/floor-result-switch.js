import { randomUUID } from 'node:crypto'
import { foldStoryRounds } from './story-rounds.js'
import { sessionEvents } from '../domain/session-events.js'
import { replaceSessionSurface } from '../domain/session-surface-mutations.js'
import { replyProse } from '../domain/reply-prose.js'

/**
 * Switch the latest floor back to another reply the round has had (fork contract C8).
 * No generation runs: the chosen generation's text (from the append-only log, listed by
 * story-rounds `history`) becomes the round's body the way an edit of the last body does
 * (timeline `body.edit`: save prose, projection caches, participants rewound), and one
 * replacement over the current reply node puts it in the model's context, naming the
 * generation it stands for (`tavernResultSeq`). Switching back is another replacement;
 * switching to the current result writes nothing.
 *
 * The floor's MVU variables are not replayed: like a body edit, the switch keeps the
 * variables the previous body settled and reports `mvu: 'stale'`. For an official MVU card
 * the save also marks the floor (`variablesStale`, read as the view's `staleVariables`)
 * until a settlement, regeneration or rollback of it.
 * 手动编辑正文不重算变量，仍保留未重算标记。
 */
export function createFloorResultSwitch({ chats, sessions, timeline, activity, project, present, sessionPatch, id = randomUUID }) {
  const pending = new Set()
  function idle(chat, agent) {
    if (agent?.phase?.kind === 'running' || chat.regenInProgress || ['pending', 'running'].includes(chat.settleStatus) || activity(chat)?.busy) {
      throw new Error('请等待当前生成或后台处理完成后再切换历史结果')
    }
  }
  function latestFloor(chat, turn) {
    const message = chat?.messages?.at(-1)
    if (message?.role !== 'assistant' || message.greeting === true || Number(message.turn) !== turn) throw new Error('只能切换最新一层的历史结果')
    return message
  }

  /** @returns {Promise<{ switched: boolean, turn: number, replySeq: number, mvu: 'stale' | 'unchanged', view: object }>} */
  async function switchResult(input = {}) {
    if (sessionPatch && !sessionPatch.replacementAllowed()) throw new Error(sessionPatch.blockReason())
    const sessionId = String(input.sessionId ?? '')
    const turn = Number(input.turn)
    const replySeq = Number(input.replySeq)
    if (!Number.isSafeInteger(turn) || turn < 1 || !Number.isSafeInteger(replySeq) || replySeq < 0) throw new Error('切换参数无效')
    if (pending.has(sessionId)) throw new Error('正在切换历史结果，请稍候')
    pending.add(sessionId)
    try {
      const chat = await chats.forSession(sessionId)
      if (!chat) throw new Error('会话不存在')
      if (!['story', 'script'].includes(chat.mode || 'story')) throw new Error('仅游玩模式支持切换历史结果')
      const agent = sessions.get(sessionId)
      const session = agent?.session
      if (!session) throw new Error('无法访问原生会话')
      idle(chat, agent)
      const message = latestFloor(chat, turn)
      const floor = foldStoryRounds(sessionEvents(session)).floors.at(-1)
      if (!floor || floor.story !== turn || !session.surface?.nodes.includes(floor.reply.seq)) throw new Error('这一层已不在当前上下文中，无法切换')
      const entry = floor.history.find(item => item.seq === replySeq)
      if (!entry) throw new Error('这一层没有这个历史结果')
      if (entry.current) return { switched: false, turn, replySeq, mvu: 'unchanged', view: await present(chat) }
      // Prose only, like an edit: macros are not replayed, the regex projections are.
      const reply = await project(entry.text, chat)
      const patch = { ...replyProse(entry.text, { ...reply, projectionText: entry.text }),
        incomplete: entry.incomplete === true, incompleteReason: entry.incompleteReason || '' }
      if (Array.isArray(message.swipes)) {
        patch.swipes = structuredClone(message.swipes)
        const swipe = Number(message.swipeId) || 0
        if (typeof patch.swipes[swipe] === 'string') patch.swipes[swipe] = entry.text
      }
      const saved = await chats.update(chat.id, current => {
        idle(current, agent)
        if (latestFloor(current, turn).text !== message.text) throw new Error('正文已变化，请刷新后再切换')
        if (!session.surface?.nodes.includes(floor.reply.seq)) throw new Error('模型上下文已变化，请刷新后再切换')
        const edited = timeline.apply({ chat: current, intent: { kind: 'body.edit', turn, patch } }).chat
        if (edited.mvu?.enabled === true && edited.mvu.owner === 'official') edited.messages.at(-1).variablesStale = { replySeq: entry.seq }
        return edited
      }, { source: 'foreground.result-switch' })
      // The save holds the switch first; a crash before this write leaves a save the
      // native repair brings the surface back to.
      replaceSessionSurface(session, 'assistant/message', {
        turn: Number(floor.reply.turn) || turn, step: 1,
        message: { id: 'tavern-result-switch:' + id(), role: 'assistant', content: [{ type: 'text', text: patch.text }],
          source: { kind: 'model', provider: 'dsh-tavern', model: 'result-switch', tavernStoryTurn: turn, tavernResultSeq: entry.seq, tavernIncomplete: entry.incomplete === true, tavernIncompleteReason: entry.incompleteReason || '' } }
      }, { start: floor.reply.seq, end: floor.reply.seq, sourceEventSeqs: [floor.reply.seq] })
      await sessions.flush(session)
      return { switched: true, turn, replySeq, mvu: 'stale', view: await present(saved) }
    } finally { pending.delete(sessionId) }
  }
  return Object.freeze({ switchResult })
}
