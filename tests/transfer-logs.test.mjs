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

test('列日志：过滤酒馆导入会话，标题回退到人物卡', async () => {
  const { logs } = harness()
  const items = await logs.list()
  assert.deepEqual(items.map(item => [item.key, item.title]), [['s-1', '雨中列车'], ['s-2', '侦探']])
  assert.equal(items[0].meta, '诊断日志')
  assert.equal(items[0].bytes, 0)
})

test('导出日志：base64 还原成 zip Buffer，缺后缀补 .zip', async () => {
  const { logs, calls } = harness()
  const items = await logs.collect(['s-1'])
  assert.deepEqual(calls, ['s-1'])
  assert.equal(items[0].fileName, 'logs.zip')
  assert.equal(items[0].content.toString('utf8'), 'zip-s-1')
})

test('导出失败带标题，未知 key 直接报错', async () => {
  const { logs } = harness()
  await assert.rejects(() => logs.collect(['s-2']), /导出「侦探」日志失败：会话仍在生成/)
  await assert.rejects(() => logs.collect(['nope']), /日志不存在：nope/)
})

test('重复 key 只导出一次', async () => {
  const { logs, calls } = harness()
  const items = await logs.collect(['s-1', 's-1'])
  assert.equal(items.length, 1)
  assert.deepEqual(calls, ['s-1'])
})
