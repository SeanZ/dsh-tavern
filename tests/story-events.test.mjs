import assert from 'node:assert/strict'
import test from 'node:test'
import { createStoryEvents } from '../tavern-plugin/lib/domain/story-events.js'

test('插件自己的事件「插件名:事件名」：第一次挂上或发出时登记，列在表里；不合格式的名字仍然拒绝', async () => {
  const heard = []
  const events = createStoryEvents()
  events.on('map-plugin:signal-changed', '插件「phone-plugin」', payload => { heard.push(payload.data) })
  events.emit('map-plugin:signal-changed', { sessionId: 'game', from: 'map-plugin', data: { strength: 0 } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(heard, [{ strength: 0 }])
  assert.deepEqual(events.table().find(row => row.event === 'map-plugin:signal-changed'), { event: 'map-plugin:signal-changed', name: 'map-plugin:signal-changed', custom: true, followers: ['插件「phone-plugin」'] })
  assert.equal(events.history('game').at(-1).event, 'map-plugin:signal-changed')
  assert.throws(() => events.on('Map Plugin:x', 'x', () => {}), /未知的剧情事件/)
  // A finished task is its own block on the timeline, not a mark.
  events.emit('task-finished', { sessionId: 'game', task: 'settlement', status: 'completed' })
  assert.notEqual(events.history('game').at(-1).event, 'task-finished')
})
