import assert from 'node:assert/strict'
import test from 'node:test'
import { Session } from './fixtures/dsh-session-host.mjs'
import { appendSessionEvent, isSurfaceEditTurn, withSurfaceEditTurn } from '../tavern-plugin/lib/domain/session-events.js'

test('a turn opened for a Tavern edit is known as one; the player\'s turns are not', () => {
  const session = Session.create('surface-edit-turn')
  appendSessionEvent(session, 'turn/start', { turn: 1 })
  appendSessionEvent(session, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  let opened
  withSurfaceEditTurn(session, null, turn => { opened = turn })
  assert.equal(opened, 2)
  assert.equal(isSurfaceEditTurn(session, 2), true)
  assert.equal(isSurfaceEditTurn(session, 1), false)
  assert.equal(isSurfaceEditTurn(Session.create('other'), 2), false)
})

test('a surface write after the round closed opens an edit turn that is known as Tavern\'s', async () => {
  const { replaceSessionSurface } = await import('../tavern-plugin/lib/domain/session-surface-mutations.js')
  const session = Session.create('surface-edit-step')
  appendSessionEvent(session, 'turn/start', { turn: 1 })
  appendSessionEvent(session, 'step/start', { turn: 1, step: 1 })
  appendSessionEvent(session, 'assistant/message', { turn: 1, step: 1, message: { id: 'reply', role: 'assistant', content: [{ type: 'text', text: '原' }], source: { kind: 'model', provider: 'f', model: 'f' } } }, { surfaceOp: 'append', sourceEventSeqs: [] })
  appendSessionEvent(session, 'step/end', { turn: 1, step: 1 })
  appendSessionEvent(session, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  const seq = session.surface.nodes.at(-1)
  replaceSessionSurface(session, 'assistant/message', { turn: 1, step: 1, message: { id: 'edit', role: 'assistant', content: [{ type: 'text', text: '改' }], source: { kind: 'model', provider: 'dsh-tavern', model: 'body-edit' } } },
    { start: seq, end: seq, sourceEventSeqs: [seq] })
  assert.equal(isSurfaceEditTurn(session, 2), true)
  assert.equal(isSurfaceEditTurn(session, 1), false)
})
