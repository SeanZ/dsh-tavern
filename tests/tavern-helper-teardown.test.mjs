import test from 'node:test'
import assert from 'node:assert/strict'

import { helperHostHarness } from './fixtures/helper-host-harness.mjs'

// 每次切换页面，消息 iframe 都会被拆掉，拆掉之后 window.parent 变 null。
// 大凉龙虎传 v4.11 的 unload 回调里还在 eventOff，于是 reportSubscriptions 抛
// "Cannot read properties of null (reading 'postMessage')"，切回页面就弹一次。
test('页面拆除后卡再摘监听不再抛错，也不再往已经不存在的宿主发消息', async () => {
  const run = helperHostHarness()
  const handler = () => {}
  const window = run.window
  window.eventOn('demo-event', handler)
  const before = run.sent.length
  assert.ok(before > 0, '正常监听会上报订阅')

  window.parent = null
  assert.doesNotThrow(() => window.eventOff('demo-event', handler))
  assert.doesNotThrow(() => window.eventRemoveAllListeners?.('demo-event'))
  assert.equal(run.sent.length, before, '拆除后不再发消息')
})

test('拆除后的初始化耗时报告同样安静地放弃', async () => {
  const run = helperHostHarness()
  const timing = run.window.__dshTavernInitializationTiming
  assert.ok(timing)
  run.window.parent = null
  assert.doesNotThrow(() => timing.dispose())
})
