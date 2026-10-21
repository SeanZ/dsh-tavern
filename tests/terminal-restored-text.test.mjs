import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeRepairGame, repairEvidence } from './fixtures/native-repair-game.mjs'
import { Session } from './fixtures/dsh-session-host.mjs'
import { hostAssistantRows } from './fixtures/host-assistant-rows.mjs'
import { projectionFixture } from './fixtures/session-view-projection.mjs'
import { sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import { replaceSessionSurface } from '../tavern-plugin/lib/domain/session-surface-mutations.js'
import { applyRegenerationProjection } from '../tavern-plugin/lib/domain/rollback-surface.js'
import { planShowsRow, planStoryTurn } from '../tavern-plugin/lib/domain/transcript-row-plan.js'

test('末轮恢复正文不同于原座位时，全量、增量和冷读都显示新正文并保留独立清理节点', async () => {
  let { session, chat } = nativeRepairGame()
  const original = sessionEvents(session).find((event) => event.seq === chat.messages.at(-1).nativeAnchor.reply)
  const data = {
    ...original.data,
    message: {
      ...original.data.message,
      id: 'tavern-regen:prior',
      source: { ...original.data.message.source, tavernStoryTurn: 3 },
    },
  }
  const old = replaceSessionSurface(session, 'assistant/message', data, {
    start: original.seq,
    end: original.seq,
    sourceEventSeqs: [original.seq],
  })
  const cleanup = replaceSessionSurface(
    session,
    'user/message',
    { id: 'cleanup', role: 'user', content: [], source: { kind: 'plugin:dsh-tavern-regeneration-abort' } },
    { start: old.seq, end: old.seq, sourceEventSeqs: [old.seq] },
  )
  // 清理节点在正文之外；用真实 mutator 追加新的独立正文恢复目标。
  const { createSessionSurfaceMutator } = await import('../tavern-plugin/lib/domain/session-surface-mutations.js')
  const surface = createSessionSurfaceMutator(session)
  let target
  surface.editStep(() => {
    target = surface.append('assistant/message', data, { surfaceOp: 'append' })
  })
  const prior = replaceSessionSurface(session, 'assistant/message', data, {
    start: target.seq,
    end: target.seq,
    sourceEventSeqs: [target.seq],
  })
  const fixture = projectionFixture({ sessionDebugEvidence: () => repairEvidence(session) })
  Object.assign(chat, { cardPath: fixture.chat.cardPath, cardName: fixture.chat.cardName, mvu: fixture.chat.mvu })
  const before = await fixture.projection.project.full(chat)
  chat.messages.at(-1).text = '恢复后的不同正文'
  const projection = {
    data: {
      ...data,
      message: {
        ...data.message,
        id: 'tavern-regen:restored',
        content: [{ type: 'text', text: chat.messages.at(-1).text }],
      },
    },
    range: { start: prior.seq, end: prior.seq, sourceEventSeqs: [prior.seq] },
  }
  applyRegenerationProjection(session, projection)
  const event = sessionEvents(session).findLast((event) => event.data?.message?.id === 'tavern-regen:restored')
  assert.deepEqual(event.sourceEventSeqs, [prior.seq])
  assert.ok(session.surface.nodes.includes(cleanup.seq))
  const views = [
    await fixture.projection.project.full(chat),
    await fixture.projection.project.cached(chat, before, { busy: false, phase: 'idle' }),
    await fixture.projection.project.dirty(chat, before, [4], { busy: false, phase: 'idle' }),
  ]
  session = Session.fromRestore(session.id, JSON.parse(JSON.stringify(sessionEvents(session))))
  views.push(await fixture.projection.project.full(chat))
  for (const view of views) {
    const rows = hostAssistantRows(sessionEvents(session))
      .filter((row) => planShowsRow(view.transcriptTurns, row))
      .map(
        (row) =>
          view.replyProjections?.find((item) => item.turn === planStoryTurn(view.transcriptTurns, row.turn))?.text ||
          row.text,
      )
    assert.deepEqual(rows, ['正文1', '正文2', '恢复后的不同正文'])
  }
  const count = sessionEvents(session).length
  applyRegenerationProjection(session, projection)
  assert.equal(sessionEvents(session).length, count)
})
