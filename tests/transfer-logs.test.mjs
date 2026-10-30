import assert from 'node:assert/strict'
import test from 'node:test'

import { createTransferLogs } from '../tavern-plugin/lib/domain/transfer-logs.js'

function harness() {
  const sessions = [
    { sessionId: 's-1', chatId: 'chat-1', title: '雨中列车', cardName: '作家', requestMode: 'dsh' },
    { sessionId: 's-2', chatId: 'chat-2', title: '', cardName: '侦探', requestMode: 'dsh' },
    { sessionId: 's-3', chatId: 'chat-3', title: '导入的存档', cardName: '', requestMode: 'sillytavern' }
  ]
  const calls = []
  const logs = createTransferLogs({
    listSessions: async () => sessions,
    exportLogs: async sessionId => {
      calls.push(sessionId)
      if (sessionId === 's-2') throw new Error('会话仍在生成')
      return { filename: sessionId === 's-1' ? 'logs.zip' : 'custom', base64: Buffer.from('zip-' + sessionId).toString('base64') }
    }
  })
  return { logs, calls }
}

test('重复 key 只导出一次', async () => {
  const { logs, calls } = harness()
  const items = await logs.collect(['s-1', 's-1'])
  assert.equal(items.length, 1)
  assert.deepEqual(calls, ['s-1'])
})
