import assert from 'node:assert/strict'
import test from 'node:test'

import { createBackgroundRunLedger } from '../tavern-plugin/lib/background-run-ledger.js'

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
  ledger.lock({ kind: 'held', sessionId: 'game', slot: 'background', role: 'settlement', operationId: 'op-1' })
  clock = 5
  ledger.lock({ kind: 'refused', sessionId: 'game', slot: 'background', role: 'candidate', holder: 'settlement' })
  clock = 9
  ledger.lock({ kind: 'released', sessionId: 'game', role: 'settlement', operationId: 'op-1', status: 'committed' })
  ledger.lock({ kind: 'held', sessionId: '', role: 'ledger', operationId: 'op-2' })
  assert.deepEqual(ledger.locks('game'), [
    { kind: 'held', slot: 'background', role: 'settlement', operationId: 'op-1', from: 0, to: 9, status: 'committed' },
    { kind: 'refused', slot: 'background', role: 'candidate', holder: 'settlement', at: 5 }])
  ledger.forget('game')
  assert.deepEqual(ledger.locks('game'), [])
})
