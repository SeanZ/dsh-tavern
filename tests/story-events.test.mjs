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
  assert.deepEqual(table.find(row => row.event === 'reply-committed'), { event: 'reply-committed', name: '正文写完', followers: ['舞台导演', '精修预审'] })
  assert.deepEqual(table.find(row => row.event === 'turn-settled').followers, [])
  assert.throws(() => events.on('nope', 'x', () => {}), /未知的剧情事件/)
  assert.throws(() => events.emit('nope'), /未知的剧情事件/)
})
