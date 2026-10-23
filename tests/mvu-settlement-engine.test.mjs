import assert from 'node:assert/strict'
import test from 'node:test'
import { createMvuSettlementEngine } from '../tavern-plugin/lib/domain/mvu-settlement-engine.js'

const engine = createMvuSettlementEngine({})
const official = { enabled: true, owner: 'official' }
const game = mvu => ({ mvu: official, messages: [{ role: 'user' }, { role: 'assistant', turn: 2, swipeId: 0, variables: [{ stat_data: { hp: 1 } }], mvu }] })

test('only an official MVU game with a waiting reply has a target; a switched-off task still delivers a saved submission', () => {
  assert.equal(engine.target({ ...game({ pending: true }), mvu: { enabled: true, owner: 'card' } }), null)
  const target = engine.target(game({ pending: true }))
  assert.equal(target.messageId, 1)
  assert.equal(engine.runs(target, { variables: false }), false)
  assert.equal(engine.runs(engine.target(game({ pending: true, pendingSubmission: {} })), { variables: false }), true)
  assert.deepEqual(engine.settings(game({ pending: true, variableRetry: true })).posture, false, 'a variable retry settles the variables alone')
})

test('the commit marks a switched-off reply skipped; a failure closes it with an error receipt', () => {
  const chat = game({ pending: true })
  const target = engine.target(chat)
  const commit = engine.completion({ mvuTarget: target, mvuResult: null, backgroundTasksSettings: { variables: false } })
  assert.equal(commit.stateChanged, false)
  assert.deepEqual(commit.messageIndices, [1])
  commit.apply(chat, {})
  assert.equal(chat.messages[1].mvu.receipt.status, 'skipped')
  assert.equal(chat.messages[1].mvu.pending, false)

  const failed = game({ pending: true })
  assert.equal(engine.recordFailure(failed, new Error('x'), '模型超时'), true)
  assert.deepEqual(failed.messages[1].mvu.receipt.failures, [{ command: '', message: '模型超时' }])
  assert.equal(engine.recordFailure({ messages: [] }, new Error('x'), 'x'), false)
})

test('a retry redelivers a waiting submission as saved, or restarts the variables; never both', () => {
  const plain = { chat: { mvu: null }, target: {}, activity: {} }
  assert.equal(engine.prepareRetry(plain), 'none')
  const waiting = () => ({ chat: { mvu: official }, target: { message: { swipeId: 0, mvu: { receipt: { status: 'pending' }, pendingSubmission: {} } } }, activity: { phase: 'pending' } })
  assert.equal(engine.prepareRetry(waiting()), 'redeliver')
  assert.throws(() => engine.prepareRetry({ ...waiting(), guidance: '多加点血' }), /只能重新投递/)
  const done = { chat: { mvu: official }, target: { message: { swipeId: 0, mvuBaseline: { swipeId: 0 }, mvu: { receipt: { status: 'updated' }, guidance: '旧意见' } } }, activity: {} }
  assert.equal(engine.prepareRetry({ ...done, guidance: ' 新意见 ' }), 'reset')
  assert.deepEqual(done.target.message.mvu, { pending: true, variableRetry: true, guidance: '新意见', modified: false, diagnostics: [], events: [] })
  const noBaseline = { chat: { mvu: official }, target: { message: { swipeId: 0, mvu: { receipt: { status: 'updated' } } } }, activity: {} }
  assert.throws(() => engine.prepareRetry(noBaseline), /没有结算前快照/)
})

for (const status of ['updated', 'unchanged', 'partial', 'stale', 'error']) {
  test(`MVU 回执 ${status} 只在成功重算后清除持久化未重算标记`, () => {
    const chat = game({ pending: true })
    const target = engine.target(chat)
    // 提交对象与读取快照分离，保证写入的是实际持久化目标。
    const persisted = structuredClone(chat)
    persisted.messages[1].variablesStale = { replySeq: 7 }
    const result = { receipt: { status }, effect: null }
    engine.completion({ mvuTarget: target, mvuResult: result, backgroundTasksSettings: {} }).apply(persisted, {})
    assert.equal(Object.hasOwn(persisted.messages[1], 'variablesStale'), !['updated', 'unchanged', 'partial'].includes(status))
    assert.equal(persisted.messages[1].mvu.receipt.status, status)
  })
}

test('过期 swipe 的成功回执不能清除新正文的未重算标记', () => {
  const chat = game({ pending: true })
  const target = engine.target(chat)
  const persisted = structuredClone(chat)
  persisted.messages[1].swipeId = 1
  persisted.messages[1].variablesStale = { replySeq: 9 }
  engine.completion({ mvuTarget: target, mvuResult: { receipt: { status: 'updated' } }, backgroundTasksSettings: {} }).apply(persisted, {})
  assert.deepEqual(persisted.messages[1].variablesStale, { replySeq: 9 })
})
