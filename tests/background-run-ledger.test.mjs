import assert from 'node:assert/strict'
import test from 'node:test'

import { createBackgroundRunLedger } from '../tavern-plugin/lib/background-run-ledger.js'
import { createBackgroundAgentRunner } from '../tavern-plugin/lib/background-agent-runner.js'

test('后台运行记录按排队、运行、结束推进，终态不可再改', () => {
  let clock = 1000
  const ledger = createBackgroundRunLedger({ now: () => clock })
  const run = ledger.begin({ sessionId: 'game', task: 'settlement', persistent: true, turn: 3, selection: { model: 'm1' } })
  assert.equal(ledger.list('game')[0].status, 'queued')
  clock = 2000
  run.start({ model: 'm2' })
  run.finish()
  run.fail(new Error('迟到的失败'))
  const [record] = ledger.list('game')
  assert.equal(record.status, 'completed')
  assert.equal(record.model, 'm2')
  assert.equal(record.lane, 'resident')
  assert.equal(record.turn, 3)
  assert.equal(record.error, undefined)
  assert.equal(record.startedAt, 2000)
})

test('取消不记错误，插件任务带插件名，列表新的在前', () => {
  const ledger = createBackgroundRunLedger()
  ledger.begin({ sessionId: 'game', task: 'stage-director' }).fail(new Error('aborted'), true)
  ledger.begin({ sessionId: 'game', task: 'plugin', pluginName: 'map' }).fail(new Error('坏了'))
  const [plugin, director] = ledger.list('game')
  assert.equal(plugin.plugin, 'map')
  assert.equal(plugin.status, 'failed')
  assert.equal(plugin.error, '坏了')
  assert.equal(director.status, 'cancelled')
  assert.equal(director.lane, 'ephemeral')
  assert.equal(director.error, undefined)
})

test('只保留最近的已结束记录，未结束的始终保留', () => {
  const ledger = createBackgroundRunLedger()
  const waiting = ledger.begin({ sessionId: 'game', task: 'candidate', persistent: true })
  for (let i = 0; i < 40; i++) { const run = ledger.begin({ sessionId: 'game', task: 'phone' }); run.start(); run.finish() }
  const list = ledger.list('game')
  assert.equal(list.length, 30)
  assert.ok(list.some(record => record.task === 'candidate' && record.status === 'queued'))
  waiting.start()
  ledger.forget('game')
  assert.deepEqual(ledger.list('game'), [])
})

test('后台 Agent 运行失败时记录为失败并带错误原因', async () => {
  const runner = createBackgroundAgentRunner({ agents: { get: () => undefined } })
  await assert.rejects(runner.run({ sessionId: 'game', task: 'ledger', persistent: true, selection: { provider: 'p', model: 'm' } }))
  const [record] = runner.runs('game')
  assert.equal(record.task, 'ledger')
  assert.equal(record.status, 'failed')
  assert.match(record.error, /前台会话不可用/)
  await runner.dispose()
})

test('结果因剧情变化作废：只改该后台会话里最近完成的同类任务', () => {
  const ledger = createBackgroundRunLedger()
  const older = ledger.begin({ sessionId: 'game', task: 'ledger', persistent: true }); older.bind('agent-1'); older.start(); older.finish()
  const other = ledger.begin({ sessionId: 'game', task: 'candidate', persistent: true }); other.bind('agent-1'); other.start(); other.finish()
  const latest = ledger.begin({ sessionId: 'game', task: 'ledger', persistent: true }); latest.bind('agent-1'); latest.start(); latest.finish()
  ledger.discard({ sessionId: 'game', role: 'ledger', agentSessionId: 'agent-1' })
  assert.deepEqual(ledger.list('game').map(record => record.status), ['discarded', 'completed', 'completed'])
  ledger.discard({ sessionId: '', role: 'candidate', agentSessionId: 'agent-1' })
  assert.equal(ledger.list('game')[1].status, 'discarded')
  ledger.discard({ sessionId: 'game', role: 'phone', agentSessionId: 'agent-1' })
  assert.equal(ledger.list('game')[2].status, 'completed')
})

test('后台锁：记下谁占用、何时释放，以及谁被挡回', () => {
  let clock = 0
  const ledger = createBackgroundRunLedger({ now: () => clock })
  ledger.lock({ kind: 'held', sessionId: 'game', role: 'settlement', operationId: 'op-1' })
  clock = 5
  ledger.lock({ kind: 'refused', sessionId: 'game', role: 'candidate', holder: 'settlement' })
  clock = 9
  ledger.lock({ kind: 'released', sessionId: 'game', role: 'settlement', operationId: 'op-1', status: 'committed' })
  ledger.lock({ kind: 'held', sessionId: '', role: 'ledger', operationId: 'op-2' })
  assert.deepEqual(ledger.locks('game'), [
    { kind: 'held', role: 'settlement', operationId: 'op-1', from: 0, to: 9, status: 'committed' },
    { kind: 'refused', role: 'candidate', holder: 'settlement', at: 5 }])
  ledger.forget('game')
  assert.deepEqual(ledger.locks('game'), [])
})
