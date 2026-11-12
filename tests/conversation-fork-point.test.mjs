import assert from 'node:assert/strict'
import test from 'node:test'
import { conversationStateAtMessage, conversationStateAtTurn, conversationForkBoundary } from '../tavern-plugin/lib/domain/conversation-fork-point.js'

// A story Chat whose snapshots are keyed by revision, exactly like storage: here
// revision == message count and each round contributes one checkpoint.
function chain(turns, turnsOf) {
  const messages = []
  const states = new Map()
  for (let turn = 1; turn <= turns; turn++) {
    messages.push({ role: 'user', text: 'input' + turn })
    messages.push({ role: 'assistant', turn: turnsOf ? turnsOf(turn) : turn, text: 'reply' + turn, variables: [{ hp: turn }] })
    states.set(messages.length, {
      id: 'chat', sessionId: 'source', mode: 'story', _storageRevision: messages.length, settleStatus: 'done',
      messages: structuredClone(messages), timeline: { checkpoints: [] }
    })
  }
  const source = structuredClone(states.get(messages.length))
  for (let turn = 1; turn < turns; turn++) source.timeline.checkpoints.push({ turn: turn + 1, beforeRevision: 2 * turn })
  const read = async (_id, revision) => structuredClone(states.get(revision))
  return { source, states, read }
}

test('重复、缺失、非单调 turn 不影响状态选择，只按消息序号对齐前缀', async () => {
  const { source, states, read } = chain(4, turn => [2, 2, 1, 3][turn - 1])
  // Checkpoint order is reversed and the snapshot's own turns differ from the source.
  source.timeline.checkpoints.reverse()
  states.get(2).messages[1].turn = 999
  const atMessage1 = await conversationStateAtMessage(source, 1, read)
  assert.equal(atMessage1.state.messages.length, 2)
  const atMessage3 = await conversationStateAtMessage(source, 3, read)
  assert.equal(atMessage3.state.messages.length, 4)
  assert.equal(atMessage3.state.messages[3].text, 'reply2')
  // No turn field anywhere: the index still picks the prefix.
  for (const row of source.messages) delete row.turn
  const turnless = await conversationStateAtMessage(source, 5, read)
  assert.equal(turnless.state.messages.length, 6)
})

test('checkpoint 已含本轮输入时，向更早的提交快照回退取正文结束状态', async () => {
  const messages = []
  for (let turn = 1; turn <= 2; turn++) messages.push({ role: 'user', text: 'in' + turn }, { role: 'assistant', text: 'out' + turn })
  const make = (rows, revision) => ({ id: 'chat', sessionId: 'source', mode: 'story', settleStatus: 'done', _storageRevision: revision,
    messages: structuredClone(messages.slice(0, rows)), timeline: { checkpoints: [] } })
  const states = new Map([[2, make(2, 2)], [3, make(3, 3)], [4, make(3, 4)]])
  // The second round's checkpoint names the state after the player's input row, so the
  // first reply's own snapshot sits before it and no forward probe can reach it.
  const source = make(4, 8)
  source.timeline.checkpoints = [{ beforeRevision: 4 }]
  const selected = await conversationStateAtMessage(source, 1, async (_id, revision) => structuredClone(states.get(revision)))
  assert.equal(selected.state._storageRevision, 2)
  assert.equal(selected.state.messages.length, 2)
})

test('没有可用快照时保持现有分叉失败语义', async () => {
  const { source, states, read } = chain(3)
  states.get(2).messages[1].text = '其他分支的正文'
  await assert.rejects(conversationStateAtMessage(source, 1, read), /快照与当前分支正文不一致/)
  await assert.rejects(conversationStateAtMessage(source, 1, async () => undefined), /历史状态快照不可用/)
  const live = chain(3)
  live.source.regenInProgress = true
  await assert.rejects(conversationStateAtMessage(live.source, 5, live.read), /正文仍在生成/)
})

test('逆序找回同正文的状态时核对已知结果身份', async () => {
  const { source, states, read } = chain(3)
  source.timeline.checkpoints = []
  source.messages[1].storyResultId = 'selected'
  states.get(2).messages[1].storyResultId = 'selected'
  const otherResult = structuredClone(states.get(2))
  otherResult._storageRevision = 5
  otherResult.messages[1].storyResultId = 'other'
  otherResult.messages[1].variables = [{ hp: 99 }]
  states.set(5, otherResult)
  const selected = await conversationStateAtMessage(source, 1, read)
  assert.equal(selected.state._storageRevision, 2)
  assert.deepEqual(selected.state.messages[1].variables, [{ hp: 1 }])
})

test('旧 turn API 回归：按 turn 找到消息后仍走按序号的状态选择，原生边界保持不变', async () => {
  const { source, read } = chain(3)
  const byTurn = await conversationStateAtTurn(source, 2, read)
  assert.equal(byTurn.turn, 2)
  assert.equal(byTurn.state.messages.length, 4)
  const auto = await conversationStateAtTurn(source, 0, read)
  assert.equal(auto.turn, 3)
  assert.equal(auto.state, source)
  await assert.rejects(conversationStateAtTurn(source, 9, read), /找不到/)
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


test('已清理快照的错误提示使用当前200回合窗口，不承诺恢复旧数据', async () => {
  const h = chain(3)
  await assert.rejects(conversationStateAtTurn(h.source, 1, async () => {
    throw Object.assign(new Error('missing'), { code: 'DSH_TAVERN_REVISION_NOT_FOUND' })
  }), /历史状态已清理.*最近 200 个原生回合/)
})
