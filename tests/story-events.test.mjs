import assert from 'node:assert/strict'
import test from 'node:test'
import { createStoryEvents } from '../tavern-plugin/lib/domain/story-events.js'

test('every follower hears the event even when another one throws or rejects; unsubscribe stops it', async () => {
  const warnings = [], heard = []
  const events = createStoryEvents({ logger: { warn: (...args) => warnings.push(args.join(' ')) } })
  events.on('turn-settled', '同步', () => { throw new Error('同步失败') })
  events.on('turn-settled', '异步', async () => { throw new Error('异步失败') })
  const stop = events.on('turn-settled', '记录', event => { heard.push(event.chatId) })
  events.emit('turn-settled', { chatId: 'a', latest: { sessionId: 's' } })
  stop()
  events.emit('turn-settled', { chatId: 'b', latest: null })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(heard, ['a'])
  assert.equal(warnings.filter(line => line.includes('本轮结算完后「同步」失败') && line.includes('同步失败')).length, 2)
  assert.equal(warnings.filter(line => line.includes('异步失败')).length, 2)
})

test('the table lists each event with the tasks it starts, in registration order', () => {
  const events = createStoryEvents()
  events.on('reply-committed', '舞台导演', () => {})
  events.on('reply-committed', '精修预审', () => {})
  const table = events.table()
  assert.deepEqual(table.find(row => row.event === 'reply-committed'), { event: 'reply-committed', name: '正文写完', custom: false, followers: ['舞台导演', '精修预审'] })
  assert.deepEqual(table.find(row => row.event === 'turn-settled').followers, [])
  assert.throws(() => events.on('nope', 'x', () => {}), /未知的剧情事件/)
  assert.throws(() => events.emit('nope'), /未知的剧情事件/)
})

test('history keeps when each moment happened, per game', () => {
  let clock = 100
  const events = createStoryEvents({ now: () => clock })
  events.emit('reply-committed', { sessionId: 'game' })
  clock = 200
  events.emit('turn-settled', { chatId: 'c', latest: { sessionId: 'game' } })
  events.emit('turn-settled', { chatId: 'c', latest: null })
  assert.deepEqual(events.history('game'), [{ event: 'reply-committed', name: '正文写完', at: 100 }, { event: 'turn-settled', name: '本轮结算完', at: 200 }])
  assert.deepEqual(events.history('other'), [])
})

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
