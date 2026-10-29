import assert from 'node:assert/strict'
import test from 'node:test'
import { createStoryEvents } from '../tavern-plugin/lib/domain/story-events.js'
import { createWorkflow } from '../tavern-plugin/lib/domain/workflow.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

test('a declared task runs on its events when its condition holds, and is listed under them', async () => {
  const events = createStoryEvents(), workflow = createWorkflow({ events }), heard = []
  workflow.job({ id: 'title', name: '对局标题', on: 'turn-settled', if: ({ chatId }) => chatId !== 'skip', run: ({ chatId, gameId }, event) => { heard.push([chatId, gameId, event]) } })
  workflow.job({ id: 'both', name: '两处', on: ['reply-committed', 'turn-settled'], run: ({ gameId }, event) => { heard.push(['both', gameId, event]) } })
  events.emit('turn-settled', { chatId: 'a', latest: { sessionId: 'game' } })
  events.emit('turn-settled', { chatId: 'skip', latest: { sessionId: 'game' } })
  // A settlement whose save could not be read names no game, so it starts no task.
  events.emit('turn-settled', { chatId: 'b', latest: null })
  events.emit('reply-committed', { sessionId: 'game' })
  await tick()
  assert.deepEqual(heard, [['a', 'game', 'turn-settled'], ['both', 'game', 'turn-settled'], ['both', 'game', 'turn-settled'], ['both', 'game', 'reply-committed']])
  assert.deepEqual(events.table().find(row => row.event === 'turn-settled').followers, ['对局标题', '两处'])
  assert.deepEqual(workflow.table().map(job => [job.id, job.name, [...job.on]]), [['title', '对局标题', ['turn-settled']], ['both', '两处', ['reply-committed', 'turn-settled']]])
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

test('needs waits for the work each needed task registered a waiter for, in order', async () => {
  const tasks = [{ task: 'settlement' }, { task: 'polish' }, { task: 'candidate', needs: ['settlement', 'polish'] }, { task: 'phone' }]
  const workflow = createWorkflow({ events: createStoryEvents(), tasks }), order = []
  let release
  workflow.waiter('settlement', async chat => { order.push('settlement ' + chat.id); await new Promise(resolve => { release = resolve }) })
  workflow.waiter('polish', chat => { order.push('polish ' + chat.id) })
  const waiting = workflow.needs('candidate', { id: 'c' })
  await tick()
  assert.deepEqual(order, ['settlement c'])
  release()
  await waiting
  assert.deepEqual(order, ['settlement c', 'polish c'])
  await workflow.needs('phone', { id: 'c' })
  assert.throws(() => workflow.waiter('nope', () => {}), /任务目录里没有/)
  assert.throws(() => workflow.waiter('polish', () => {}), /已登记/)
  const bare = createWorkflow({ events: createStoryEvents(), tasks })
  await assert.rejects(bare.needs('candidate', { id: 'c' }), /没有登记等待方式/)
})

test('a task that needs others starts once they all finished the turn, hears their outputs; rewinding drops them', async () => {
  const events = createStoryEvents(), workflow = createWorkflow({ events, logger: { warn() {} } }), heard = []
  workflow.job({ id: 'map', on: 'task-finished', run: async ({ turn }) => ({ place: '花店', turn }) })
  workflow.job({ id: 'weather', on: 'task-finished', run: () => '雨' })
  workflow.job({ id: 'phone', needs: ['map', 'weather'], run: ({ gameId, turn, needs }) => { heard.push([gameId, turn, needs]) } })
  assert.throws(() => workflow.job({ id: 'self', needs: ['self'], run() {} }), /不能等它自己/)
  events.emit('task-finished', { sessionId: 'game', turn: 3 })
  await tick(); await tick()
  assert.deepEqual(heard, [['game', 3, { map: { place: '花店', turn: 3 }, weather: '雨' }]])
  assert.deepEqual(workflow.output('game', 3, 'map'), { place: '花店', turn: 3 })
  assert.equal(workflow.output('game', 3, 'phone'), null, 'a run that returns nothing still finished')
  // It runs once per turn, however often what it needs finishes again.
  events.emit('task-finished', { sessionId: 'game', turn: 3 })
  await tick(); await tick()
  assert.equal(heard.length, 1)
  assert.deepEqual(events.table().find(row => row.event === 'story-rewound').followers, ['作废任务产出'])
  events.emit('story-rewound', { sessionId: 'game', kind: 'rollback', turn: 3 })
  assert.equal(workflow.output('game', 3, 'map'), undefined)
  // Taken back, the turn is played again: it runs again.
  events.emit('task-finished', { sessionId: 'game', turn: 3 })
  await tick(); await tick()
  assert.equal(heard.length, 2)
  // A moment with no turn keeps no output.
  events.emit('task-finished', { sessionId: 'game' })
  await tick(); await tick()
  assert.equal(heard.length, 2)
})

test('each run of a declared task is kept per game: what started it, when, and how it ended', async () => {
  let clock = 100
  const events = createStoryEvents({ logger: { warn() {} } })
  const workflow = createWorkflow({ events, logger: { warn() {} }, now: () => clock })
  workflow.job({ id: 'locate', name: '定位', task: 'plugin:map:locate', on: 'task-finished', if: ({ task }) => task === 'settlement', run: async () => { clock = 300; return 1 } })
  workflow.job({ id: 'call', name: '来电', needs: ['locate'], run: () => { throw new Error('打不通') } })
  events.emit('task-finished', { sessionId: 'game', task: 'candidate', turn: 2 })
  events.emit('task-finished', { sessionId: 'game', task: 'settlement', turn: 2 })
  for (let i = 0; i < 4; i++) await tick()
  assert.deepEqual(workflow.runs('game'), [
    { id: 'locate', name: '定位', task: 'plugin:map:locate', event: 'task-finished', cause: 'settlement', turn: 2, at: 100, endedAt: 300, status: 'completed' },
    { id: 'call', name: '来电', task: '', event: 'needs', needs: ['locate'], turn: 2, at: 300, endedAt: 300, status: 'failed', error: '打不通' }])
  assert.deepEqual(workflow.runs('other'), [])
})
