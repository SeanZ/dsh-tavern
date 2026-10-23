import { Session } from './dsh-session-host.mjs'
import { appendSessionEvent, sessionEvents } from '../../tavern-plugin/lib/domain/session-events.js'
import { roundAnchor } from '../../tavern-plugin/lib/domain/round-anchor.js'
import { nativeOpeningMessageId } from '../../tavern-plugin/lib/domain/native-opening.js'

export function nativeRepairGame() {
  const session = Session.create('repair-game')
  const chat = { id: 'repair-save', sessionId: session.id, mode: 'story', _storageRevision: 1, messages: [] }
  for (const turn of [1, 2, 3]) {
    appendSessionEvent(session, 'turn/start', { turn })
    appendSessionEvent(session, 'step/start', { turn, step: 1 })
    const input = appendSessionEvent(
      session,
      'user/message',
      {
        id: `input-${turn}`,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: `行动${turn}` }],
      },
      { surfaceOp: 'append' },
    )
    const reply = appendSessionEvent(
      session,
      'assistant/message',
      {
        turn,
        step: 1,
        message: {
          id: turn === 1 ? nativeOpeningMessageId(chat.id) : `reply-${turn}`,
          role: 'assistant',
          source: { kind: 'model', provider: 'fixture', model: 'fixture' },
          content: [{ type: 'text', text: `正文${turn}` }],
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [] },
    )
    appendSessionEvent(session, 'step/end', { turn, step: 1 })
    appendSessionEvent(session, 'turn/end', { turn, reason: { kind: 'completed' } })
    if (turn > 1) chat.messages.push({ role: 'user', text: `行动${turn}` })
    chat.messages.push({
      role: 'assistant',
      turn,
      text: `正文${turn}`,
      ...(turn === 1 ? { greeting: true } : { nativeAnchor: roundAnchor(turn, input, reply) }),
    })
  }
  return { session, chat }
}

export function repairEvidence(session) {
  return { session, loaded: true, events: sessionEvents(session), nodes: session.surface.nodes }
}
