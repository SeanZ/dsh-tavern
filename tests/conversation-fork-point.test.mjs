import assert from 'node:assert/strict'
import test from 'node:test'
import { conversationStateAtTurn, conversationForkBoundary } from '../tavern-plugin/lib/domain/conversation-fork-point.js'

function history(count = 85) {
  const states = new Map()
  let messages = []
  for (let turn = 1; turn <= count; turn++) {
    messages.push({ role: 'user', text: 'input' + turn }, { role: 'assistant', turn, text: 'reply' + turn, variables: [{ hp: turn }] })
    states.set(turn, { id: 'chat', sessionId: 'source', mode: 'story', _storageRevision: turn, settleStatus: 'done', messages: structuredClone(messages),
      posture: 'place' + turn, scriptState: { cursor: turn }, ledger: { turn }, mvu: { enabled: true }, variables: { hp: turn },
      timeline: { checkpoints: Array.from({ length: turn - 1 }, (_, i) => ({ turn: i + 2, beforeRevision: i + 1 })).slice(-40) } })
  }
  return { source: states.get(count), states, read: async (_id, revision) => structuredClone(states.get(revision)) }
}

test('缺少、变化或未完成的历史状态不使用当前变量冒充', async () => {
  const h = history(3)
  await assert.rejects(conversationStateAtTurn(h.source, 999, h.read), /找不到/)
  await assert.rejects(conversationStateAtTurn(h.source, 1, async () => undefined), /不可用/)
  h.states.get(1).messages[1].text = '其他分支'
  await assert.rejects(conversationStateAtTurn(h.source, 1, h.read), /不一致/)
  h.states.get(2).settleStatus = 'running'
  await assert.rejects(conversationStateAtTurn(h.source, 2, h.read), /结算/)
})

function native() {
  const events = []
  for (const turn of [1, 2, 3]) {
    events.push({ seq: events.length, type: 'turn/start', data: { turn } })
    events.push({ seq: events.length, type: 'assistant/message', data: { turn, message: { id: 'm' + turn, source: { kind: 'model' }, content: [{ type: 'text', text: 'reply' + turn }] } } })
    events.push({ seq: events.length, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  return { events }
}

test('原生分叉边界按所选回合确定，不把后续模型历史带入', () => {
  const session = native()
  assert.equal(conversationForkBoundary(session, {}, 1), 2)
  assert.equal(conversationForkBoundary(session, {}, 2), 5)
  assert.equal(conversationForkBoundary(session, {}, 3), 8)
  assert.throws(() => conversationForkBoundary(session, {}, 4), /边界/)
})

test('失败尝试必须有同一轮已接纳投影才可分叉，且不能跨过新玩家输入', () => {
  const session = native()
  session.events = session.events.slice(0, 6)
  const add = (type, data, extra = {}) => session.events.push({ seq: session.events.length, type, data, ...extra })
  add('turn/start', { turn: 3 })
  add('turn/end', { turn: 3, reason: { kind: 'interrupted' } })
  const state = { regeneratedDshTurns: { 2: 3 } }
  assert.throws(() => conversationForkBoundary(session, state, 2), /缺少已完成/)
  add('turn/start', { turn: 4 })
  add('assistant/message', { turn: 4, message: { id: 'partial', source: { kind: 'model', tavernStoryTurn: 2, tavernResultOrigin: true, tavernResultTurn: 3 }, content: [{ type: 'text', text: '部分正文' }] } }, { surfaceOp: { op: 'replace', start: 4, end: 4 } })
  add('turn/end', { turn: 4, reason: { kind: 'completed' } })
  assert.equal(conversationForkBoundary(session, state, 2), 10)
  session.events[9].data.message.source.tavernResultTurn = 99
  assert.throws(() => conversationForkBoundary(session, state, 2), /缺少已完成/)
  session.events[9].data.message.source.tavernResultTurn = 3
  session.events.splice(9, 0, { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '新输入' }] } })
  session.events.forEach((event, index) => { event.seq = index })
  assert.throws(() => conversationForkBoundary(session, state, 2), /后续上下文/)
})
