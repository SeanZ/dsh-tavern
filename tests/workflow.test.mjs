import assert from 'node:assert/strict'
import test from 'node:test'
import { createStoryEvents } from '../tavern-plugin/lib/domain/story-events.js'
import { createWorkflow } from '../tavern-plugin/lib/domain/workflow.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

test('a declared task runs on its events when its condition holds, and is listed under them', async () => {
  const events = createStoryEvents(), workflow = createWorkflow({ events }), heard = []
  workflow.job({ id: 'title', name: '对局标题', on: 'turn-settled', if: ({ latest }) => Boolean(latest), run: ({ chatId }, event) => { heard.push([chatId, event]) } })
  workflow.job({ id: 'both', name: '两处', on: ['reply-committed', 'turn-settled'], run: (_, event) => { heard.push(['both', event]) } })
  events.emit('turn-settled', { chatId: 'a', latest: { sessionId: 'game' } })
  events.emit('turn-settled', { chatId: 'b', latest: null })
  events.emit('reply-committed', { sessionId: 'game' })
  await tick()
  assert.deepEqual(heard, [['a', 'turn-settled'], ['both', 'turn-settled'], ['both', 'turn-settled'], ['both', 'reply-committed']])
  assert.deepEqual(events.table().find(row => row.event === 'turn-settled').followers, ['对局标题', '两处'])
  assert.deepEqual(workflow.table().map(job => [job.id, job.name, [...job.on]]), [['title', '对局标题', ['turn-settled']], ['both', '两处', ['reply-committed', 'turn-settled']]])
})

test('a failing task is reported under its name; removing it stops it and frees the id', async () => {
  const warnings = []
  const events = createStoryEvents({ logger: { warn: (...args) => warnings.push(args.join(' ')) } })
  const workflow = createWorkflow({ events })
  const stop = workflow.job({ id: 'x', name: '存档整理', on: 'turn-settled', run: async () => { throw new Error('坏了') } })
  events.emit('turn-settled', { chatId: 'a', latest: null })
  await tick()
  assert.ok(warnings.some(line => line.includes('本轮结算完后「存档整理」失败') && line.includes('坏了')))
  stop()
  assert.deepEqual(workflow.table(), [])
  assert.deepEqual(events.table().find(row => row.event === 'turn-settled').followers, [])
  workflow.job({ id: 'x', name: '再来', on: 'turn-settled', run: () => {} })
})

test('declarations are checked', () => {
  const workflow = createWorkflow({ events: createStoryEvents() })
  const run = () => {}
  assert.throws(() => workflow.job({ name: 'a', on: 'turn-settled', run }), /缺少 id/)
  assert.throws(() => workflow.job({ id: 'a', run }), /缺少触发事件/)
  assert.throws(() => workflow.job({ id: 'a', on: 'turn-settled' }), /缺少 run/)
  assert.throws(() => workflow.job({ id: 'a', on: 'turn-settled', if: true, run }), /if 必须是函数/)
  assert.throws(() => workflow.job({ id: 'a', on: 'nope', run }), /未知的剧情事件/)
  workflow.job({ id: 'a', on: 'turn-settled', run })
  assert.throws(() => workflow.job({ id: 'a', on: 'turn-settled', run }), /已声明/)
})
