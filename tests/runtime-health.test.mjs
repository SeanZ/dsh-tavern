import assert from 'node:assert/strict'
import test from 'node:test'

import { createRuntimeLogBuffer, runtimeHealthReport } from '../tavern-plugin/lib/domain/runtime-health.js'

test('只收酒馆自己的警告报错，密钥隐去，原输出照常', () => {
  const printed = []
  const target = { warn: (...args) => printed.push(['warn', ...args]), error: (...args) => printed.push(['error', ...args]) }
  const logs = createRuntimeLogBuffer({ now: () => 0 })
  const undo = logs.install(target)
  target.warn('dsh-tavern: 读取失败 Bearer abcdefghijklmnop')
  target.error('别的插件出错')
  target.error(new Error('dsh-tavern: 结算失败'))
  undo()
  target.warn('dsh-tavern: 卸载后不再记录')
  assert.equal(printed.length, 4, '原输出不受影响')
  assert.deepEqual(logs.read().map(line => [line.level, line.message]), [['warn', 'dsh-tavern: 读取失败 [已隐藏]'], ['error', 'dsh-tavern: 结算失败']])
})

test('运行状况报告给出请求耗时分布、慢请求最慢的阶段和最近报错', () => {
  const logs = createRuntimeLogBuffer({ now: () => 1000 })
  logs.record('warn', ['dsh-tavern: 慢'])
  const performance = { read: () => ({
    recent: [{ durationMs: 50 }, { durationMs: 80 }, { durationMs: 4000 }],
    slow: [{ method: 'getSession', receivedAt: 0, durationMs: 4000, eventLoopDelayMaxMs: 900, stages: [{ name: 'readChat', durationMs: 300 }, { name: 'buildView', durationMs: 3500 }] }],
    openings: []
  }) }
  const report = runtimeHealthReport({ version: '9.9.9', performance, logs, now: () => 0 })
  assert.equal(report.tavernVersion, '9.9.9')
  assert.equal(report.requests.maxMs, 4000)
  assert.deepEqual(report.requests.slow[0].slowestStages[0], { name: 'buildView', durationMs: 3500 })
  assert.equal(report.logs[0].message, 'dsh-tavern: 慢')
})
