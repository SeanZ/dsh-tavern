import assert from 'node:assert/strict'
import test from 'node:test'

import { createForegroundHandoff } from '../tavern-plugin/lib/domain/foreground-handoff.js'

test('候选重生成跳过普通下一回合的世界同步与失败清理', async () => {
  const order = []
  const handoff = createForegroundHandoff({
    store: { async chatForSession() { return { id: 'chat', mode: 'story', messages: [{ role: 'assistant', text: '旧正文' }],
      regenInProgress: true, regenRecovery: { candidateFrame: { kind: 'foreground' } } } } },
    tasks: { activity() { throw new Error('候选准备不得读取普通任务状态') } },
    async queueBackground() {},
    async beforeNextTurn() { order.push('beforeNextTurn') },
    async clearFailedTurns() { order.push('clearFailedTurns') },
    async syncWorldBook() { order.push('syncWorldBook') },
    turns: { async finalize() {}, async discard() {}, async prepare() { order.push('prepare'); return { ready: true } } }
  })
  const prepared = await handoff.prepare({ sessionId: 'session', turn: 3, userText: '继续' })
  assert.equal(prepared.ready, true)
  assert.deepEqual(order, ['prepare'])
})

test('连续打断的下一轮等待异步丢弃，其他会话不被阻塞', async () => {
  const queue = [], order = []
  let finish
  const cleanup = new Promise(resolve => { finish = resolve })
  const handoff = createForegroundHandoff({
    defer: fn => queue.push(fn),
    store: { async chatForSession(id) { order.push('read:' + id); return { id } } },
    tasks: { activity: () => ({}) }, queueBackground: async () => {},
    turns: { finalize: async () => {}, async discard() { order.push('discard'); await cleanup },
      async prepare(input) { order.push('prepare:' + input.sessionId) } },
    async cleanupFailedTurn() { order.push('cleaned') }
  })
  handoff.end({ sessionId: 's1', turn: 2, reason: 'interrupted' })
  const next = handoff.prepare({ sessionId: 's1' })
  await handoff.prepare({ sessionId: 's2' })
  assert.deepEqual(order, ['read:s2', 'prepare:s2'])
  queue.shift()()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(order.at(-1), 'discard')
  assert.ok(!order.includes('read:s1'))
  finish()
  await next
  assert.deepEqual(order.slice(-3), ['cleaned', 'read:s1', 'prepare:s1'])
})

test('a turn that ends in an error records why on its kept input before the discard', async () => {
  const order = []
  const handoff = createForegroundHandoff({
    store: { async chatForSession() { return { id: 'chat' } } },
    tasks: { activity() { return {} } }, async queueBackground() {},
    defer: work => work(),
    turns: { async finalize() {}, async prepare() {},
      async recordFailure(input) { order.push(['failure', input]) },
      async discard(target) { order.push(['discard', target]) } }
  })
  handoff.end({ sessionId: 's', turn: 4, reason: 'error', error: { code: 'BAD_REQUEST', message: 'API error (400): invalid thinking signature' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, [
    ['failure', { sessionId: 's', turn: 4, code: 'BAD_REQUEST', message: '这一轮没有生成正文：API error (400): invalid thinking signature' }],
    ['discard', { sessionId: 's', turn: 4 }]
  ])
  // A stop by the player is not a failure.
  order.length = 0
  handoff.end({ sessionId: 's', turn: 5, reason: 'aborted' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, [['discard', { sessionId: 's', turn: 5 }]])
})

test('awaitOpening waits for the card scripts only while the MVU opening is pending', async () => {
  let status = 'pending', waited = 0
  const handoff = createForegroundHandoff({
    store: { async chatForSession() { return { mvu: { enabled: true, owner: 'official', openingInitialization: { status } } } } },
    scriptDispatch: { async waitUntilReady(id) { assert.equal(id, 's'); waited++; status = 'complete' } },
    tasks: { activity() { return {} } }, async queueBackground() {},
    turns: { async finalize() {}, async prepare() {}, async discard() {} }
  })
  await handoff.awaitOpening('s')
  status = 'complete'
  await handoff.awaitOpening('s')
  assert.equal(waited, 1)
})

test('失败已经通知时，重试仍等待旧回合占位和消息面清理', async () => {
  const order = [], failure = Promise.withResolvers(), cleanup = Promise.withResolvers()
  const handoff = createForegroundHandoff({
    store: { async chatForSession() { return { id: 'chat' } } },
    tasks: { activity: () => ({}) }, queueBackground: async () => {},
    turns: { async finalize() {},
      async recordFailure() { failure.resolve() },
      async discard() { await cleanup.promise; order.push('discarded') } },
    async cleanupFailedTurn() { order.push('tombstoned') }
  })
  handoff.end({ sessionId: 's1', turn: 2, reason: 'error' })
  await failure.promise
  const retry = handoff.waitForDiscard('s1').then(() => order.push('retry'))
  await handoff.waitForDiscard('s2')
  assert.deepEqual(order, [])
  cleanup.resolve()
  await retry
  assert.deepEqual(order, ['discarded', 'tombstoned', 'retry'])
})

test('旧 runtime ready 不能放行尚未持久化完成的开场', async () => {
  let prepared = 0
  const handoff = createForegroundHandoff({
    store: { async openingStateForSession() { return { chat: { mvu: { enabled: true, owner: 'official', openingInitialization: { status: 'pending' } } } } } },
    scriptDispatch: { async waitUntilReady() {} },
    tasks: { activity: () => ({}) }, queueBackground: async () => {},
    turns: { async finalize() {}, async discard() {}, async prepare() { prepared++ } }
  })
  await assert.rejects(handoff.awaitOpening('s'), /开场初始化尚未完成/)
  await assert.rejects(handoff.prepare({ sessionId: 's' }), /开场初始化尚未完成/)
  assert.equal(prepared, 0)
})
