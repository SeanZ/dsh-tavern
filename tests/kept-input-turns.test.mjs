import test from 'node:test'
import assert from 'node:assert/strict'
import { keptPlayerInputTurns } from '../tavern-plugin/lib/domain/rollback-surface.js'
import { Session } from './fixtures/dsh-session-host.mjs'
import { projectionFixture } from './fixtures/session-view-projection.mjs'
import { appendSessionEvent, sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import { replaceSessionSurface } from '../tavern-plugin/lib/domain/session-surface-mutations.js'

const model = { kind: 'model', provider: 'p', model: 'm' }
const start = turn => ({ type: 'turn/start', data: { turn } })
const end = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } })
const human = text => ({ type: 'user/message', surfaceOp: 'append', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const plugin = text => ({ type: 'user/message', surfaceOp: 'append', data: { role: 'user', source: { kind: 'plugin:dsh-tavern-regen' }, content: [{ type: 'text', text }] } })
const body = (turn, text) => ({ type: 'assistant/message', surfaceOp: 'append', data: { turn, step: 1, message: { source: model, content: [{ type: 'text', text }] } } })
function log(...items) { return items.map((event, seq) => ({ ...event, seq })) }

// 失败的一轮：玩家输入后没有正文，随后重试在另一个原生回合写出正文。
function failedThenRetry() {
  return log(start(1), human('第一句'), body(1, '第一段'), end(1),
    start(2), human('第二句'), end(2, 'error'),
    start(3), plugin('第二句'), body(3, 'Pass'), end(3))
}

test('玩家已经发下一条后，不再保留更早失败轮的输入', () => {
  const events = log(start(1), human('第一句'), body(1, '第一段'), end(1),
    start(2), human('第二句'), end(2, 'error'),
    start(3), human('第三句'), body(3, '第三段'), end(3))
  assert.deepEqual(keptPlayerInputTurns({ events, replyTurns: [3], suppressed: [2] }), [])
})
// 真实 Session 事件链：失败轮 2 的输入被重试（第 3 轮）采用后，再次重新生成这一轮（第 4 轮）。
// 第 3 轮 completed 不结束第 2 轮输入的归属：新尝试回答的仍是那句输入。
test('失败输入被重试采用后再重新生成，生成中和提交后都保留玩家输入行', async () => {
  const session = Session.create('kept-input-regen-again')
  const ev = (type, data, intent) => appendSessionEvent(session, type, data, intent)
  const user = (id, text, kind) => ev('user/message', { id, role: 'user', content: [{ type: 'text', text }], source: { kind } }, { surfaceOp: 'append' })
  const reply = (turn, id, text) => ev('assistant/message', { turn, step: 1, message: { id, role: 'assistant', content: [{ type: 'text', text }], source: model } }, { surfaceOp: 'append' })
  const open = turn => { ev('turn/start', { turn }); ev('step/start', { turn, step: 1 }) }
  const close = (turn, kind = 'completed') => { ev('step/end', { turn, step: 1 }); ev('turn/end', { turn, reason: { kind } }) }
  open(1); user('i1', '第一句', 'user'); reply(1, 'r1', '第一段'); close(1)
  open(2); user('i2', '第二句', 'user'); close(2, 'error')
  open(3); user('g3', '第二句', 'plugin:dsh-tavern-regen'); const adopted = reply(3, 'r3', '正文A'); close(3)
  const fixture = projectionFixture({ sessionDebugEvidence: () => ({ session, loaded: true, events: sessionEvents(session), nodes: session.surface.nodes }) })
  const messages = [{ role: 'user', text: '第一句' }, { role: 'assistant', turn: 1, text: '第一段' }, { role: 'user', text: '第二句' }, { role: 'assistant', turn: 3, text: '正文A' }]
  const project = chat => fixture.projection.project.full(Object.assign(fixture.chat, { sessionId: session.id, suppressedDshTurns: [2], regenInProgress: false, replacingDshTurns: [] }, chat))
  const assertKept = (view, label) => {
    assert.deepEqual(view.keptInputTurns, [2], label)
    assert.equal(view.transcriptTurns['2']?.input, 1, label + '：第 2 轮的玩家输入行仍然显示')
  }
  assertKept(await project({ messages }), '再次重新生成之前')
  open(4); user('g4', '第二句', 'plugin:dsh-tavern-regen')
  assertKept(await project({ regenInProgress: true, replacingDshTurns: [3], messages: messages.slice(0, 2) }), '生成中')
  const latest = reply(4, 'r4', '正文B'); close(4)
  const nodes = session.surface.nodes
  replaceSessionSurface(session, 'assistant/message',
    { turn: 3, step: 1, message: { id: 'tavern-regen:op', role: 'assistant', content: [{ type: 'text', text: '正文B' }], source: { ...model, tavernStoryTurn: 3 } } },
    { start: adopted.seq, end: latest.seq, sourceEventSeqs: nodes.slice(nodes.indexOf(adopted.seq)).map(Number) })
  assertKept(await project({ messages: [...messages.slice(0, 3), { role: 'assistant', turn: 3, text: '正文B' }] }), '提交后')
})
