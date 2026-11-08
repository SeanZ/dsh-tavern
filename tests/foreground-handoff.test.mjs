import assert from 'node:assert/strict'
import test from 'node:test'

import { createForegroundHandoff } from '../tavern-plugin/lib/domain/foreground-handoff.js'

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
