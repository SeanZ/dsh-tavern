import assert from 'node:assert/strict'
import test from 'node:test'

import { createForegroundHandoff } from '../tavern-plugin/lib/domain/foreground-handoff.js'

test('Foreground Turn 完成后立即排队待处理的后台结算', async () => {
  const deferred = []
  const queued = []
  const chat = { id: 'chat-1' }
  const handoff = createForegroundHandoff({
    turns: { async finalize(input) { return { saved: true, chatId: chat.id, input } }, async discard() {} },
    store: { async chatForSession() { return chat } },
    tasks: { activity() { return { phase: 'pending', busy: true, role: 'settlement' } } },
    async queueBackground(chatId) { queued.push(chatId) },
    replyCommitted(sessionId) { reviewed.push(sessionId) },
    defer(run) { deferred.push(run) },
    logger: { error() {} }
  })
  const reviewed = []

  await handoff.finalize({ sessionId: 'session-1', turn: 1, userText: '向前走', assistantText: '雨夜。' })
  assert.equal(handoff.end({ sessionId: 'session-1', turn: 1, reason: 'completed' }), true)
  assert.deepEqual(queued, [])
  assert.equal(deferred.length, 1)
  deferred[0]()
  await new Promise(function (resolve) { setImmediate(resolve) })
  assert.deepEqual(queued, ['chat-1'])
  // 正文写完 is announced with the reply, beside settlement.
  assert.deepEqual(reviewed, ['session-1'])
})

test('发送前先清掉遗留的失败回合，再准备本轮（#193）', async () => {
  const order = []
  const handoff = createForegroundHandoff({
    store: { async chatForSession() { return { id: 'chat-4', mode: 'story', messages: [] } } },
    tasks: { activity() { return { phase: 'idle', busy: false, role: '' } } },
    async queueBackground() {},
    clearFailedTurns: async sessionId => { order.push('clear:' + sessionId) },
    turns: { async finalize() {}, async discard() {}, async prepare() { order.push('prepare') } }
  })
  await handoff.prepare({ sessionId: 'session-4', turn: 3, userText: '教室写字' })
  assert.deepEqual(order, ['clear:session-4', 'prepare'])
})

test('开场与无结算的正文完成都不排队后台结算', async () => {
  const deferred = []
  const chat = { id: 'chat', mode: 'story', messages: [{ greeting: true }] }
  const retired = () => assert.fail('retired recall hook')
  const handoff = createForegroundHandoff({
    store: { chatForSession: async () => chat },
    turns: { discard: async () => {}, prepare: async () => ({}), finalize: async () => ({ saved: true, chatId: chat.id }) },
    tasks: { activity: () => ({ phase: 'idle', busy: false }) },
    queueBackground: retired, defer: fn => deferred.push(fn), logger: { error: retired }
  })
  await handoff.prepare({ sessionId: 'parent', turn: 1 })
  await handoff.finalize({ sessionId: 'parent', turn: 1 })
  handoff.end({ sessionId: 'parent', turn: 1, reason: 'completed' })
  for (const run of deferred) run()
  await new Promise(resolve => setImmediate(resolve))
})

test('a failed or stopped reply announces 回合作废 and cleans the turn up', async () => {
  const discarded = [], cleaned = []
  const handoff = createForegroundHandoff({
    turns: { async finalize() {}, async discard(target) { cleaned.push(target.turn) } },
    store: { async chatForSession() { return { id: 'chat-1' } } },
    tasks: { activity() { return { phase: 'idle', busy: false, role: '' } } },
    async queueBackground() {},
    turnDiscarded: (sessionId, turn) => discarded.push(sessionId + ':' + turn),
    defer: run => run()
  })
  assert.equal(handoff.end({ sessionId: 'game', turn: 3, reason: 'error' }), true)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(discarded, ['game:3'])
  assert.deepEqual(cleaned, [3])
})

test('a Tavern edit\'s own turn announces no 正文写完, but still starts a due settlement', async () => {
  const announced = [], queued = []
  const handoff = createForegroundHandoff({
    turns: { async finalize() {}, async discard() {} }, store: { async chatForSession() { return { id: 'chat' } } },
    tasks: { activity: () => ({ role: 'settlement', phase: 'pending' }) },
    replyCommitted: id => announced.push(id), queueBackground: async id => { queued.push(id) }, defer: work => work()
  })
  handoff.end({ sessionId: 'game', turn: 9, reason: 'completed', edit: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual([announced, queued], [[], ['chat']])
})
