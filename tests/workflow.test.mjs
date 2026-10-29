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

test('cancelOn moments stop a task, listed as 取消 under them', async () => {
  const events = createStoryEvents(), workflow = createWorkflow({ events }), cancelled = []
  const stop = workflow.job({ id: 'director', name: '舞台导演', on: 'reply-committed', run: () => {},
    cancelOn: 'turn-discarded', cancel: ({ gameId, turn }) => { cancelled.push([gameId, turn]) } })
  events.emit('turn-discarded', { sessionId: 'game', turn: 3 })
  await tick()
  assert.deepEqual(cancelled, [['game', 3]])
  assert.deepEqual(events.table().find(row => row.event === 'turn-discarded').followers, ['取消舞台导演'])
  stop()
  events.emit('turn-discarded', { sessionId: 'game', turn: 4 })
  assert.deepEqual(cancelled, [['game', 3]])
  assert.throws(() => workflow.job({ id: 'x', on: 'reply-committed', run: () => {}, cancelOn: 'turn-discarded' }), /缺少 cancel/)
})

test('a failing task is reported under its name; removing it stops it and frees the id', async () => {
  const warnings = []
  const events = createStoryEvents({ logger: { warn: (...args) => warnings.push(args.join(' ')) } })
  const workflow = createWorkflow({ events })
  const stop = workflow.job({ id: 'x', name: '存档整理', on: 'turn-settled', run: async () => { throw new Error('坏了') } })
  events.emit('turn-settled', { chatId: 'a', latest: { sessionId: 'game' } })
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

test('before the next turn, the work of every task that blocks it is waited for', async () => {
  const tasks = [{ task: 'settlement', blocksNextTurn: true }, { task: 'phone' }, { task: 'plugin', blocksNextTurn: true }]
  const workflow = createWorkflow({ events: createStoryEvents(), tasks }), waited = []
  workflow.waiter('settlement', chat => { waited.push('settlement ' + chat.id) })
  workflow.waiter('phone', () => assert.fail('the next turn does not wait for the phone'))
  workflow.waiter('plugin', async chat => { waited.push('plugin ' + chat.id) })
  await workflow.beforeNextTurn({ id: 'c' })
  assert.deepEqual(waited, ['settlement c', 'plugin c'])
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

test('a task a flow starts itself is declared only: listed under its moment, never run from it', () => {
  const events = createStoryEvents(), workflow = createWorkflow({ events })
  workflow.job({ id: 'settlement', name: '变量结算', task: 'settlement', flow: true, on: 'reply-committed' })
  events.emit('reply-committed', { sessionId: 'game' })
  assert.deepEqual(events.table().find(row => row.event === 'reply-committed').followers, ['变量结算（流程启动）'])
  assert.equal(workflow.table()[0].flow, true)
  assert.throws(() => workflow.job({ id: 'x', flow: true, on: 'reply-committed', run() {} }), /不能有 run/)
})
