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
