import test from 'node:test'
import assert from 'node:assert/strict'
import { helperClient } from './fixtures/helper-host-harness.mjs'
import { announceHelperDocument } from './fixtures/helper-document-handshake.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))

test('开场切换退役旧初始化；完成后的刷新和普通回退复用运行时', async t => {
  const listeners = {}, frames = [], replies = []
  let finishWrite
  const runtime = helperClient.createTavernHelperScriptRuntime({
    window: { crypto: { randomUUID: () => 'opening-test' }, setTimeout, clearTimeout,
      addEventListener(name, fn) { listeners[name] = fn }, removeEventListener() {} },
    document: { body: { appendChild() {} }, createElement(tag) {
      if (tag === 'div') return { isConnected: true, appendChild() {}, remove() {} }
      const frame = { contentWindow: { postMessage(message) { replies.push(message) } }, listeners: {}, removed: false,
        addEventListener(name, fn) { this.listeners[name] = fn }, remove() { this.removed = true } }
      frames.push(frame)
      return frame
    } },
    rpc: async method => method === 'updateTavernHelperMessages' ? new Promise(resolve => { finishWrite = resolve }) : {},
    reportError() {}, resolveError() {}, mutationCoalesceMs: 0
  })
  t.after(() => runtime.dispose())
  const initial = { chatId: 'chat', stateRevision: 1, lifecycleRevision: 0,
    openingInitialization: { status: 'pending' }, chatVariables: {},
    messages: [{ message_id: 0, role: 'assistant', message: '开场甲', variables: {} }] }
  const view = context => ({ chatId: 'chat', tavernHelper: context,
    tavernHelperScripts: [{ id: 'companion', content: 'void 0' }], tavernMvuRuntime: { owner: 'official', assetUrl: '/bundle.js' } })
  runtime.sync('session', view(initial))
  const first = frames[0]
  first.listeners.load(); announceHelperDocument(first, listeners.message, 'first-document')
  const token = replies.findLast(row => row.type === 'dsh-tavern-helper-context').token
  listeners.message({ source: first.contentWindow, data: { token, type: 'dsh-tavern-helper-subscriptions', ready: true, names: [] } })
  listeners.message({ source: first.contentWindow, data: { token, type: 'dsh-tavern-helper-call', requestId: 'old-write',
    method: 'updateTavernHelperMessages', scriptId: 'companion', lifecycleRevision: 0,
    args: { messages: [{ message_id: 0, swipes_data: [{ stat_data: { opening: '甲' }, schema: {} }] }] } } })
  await tick()
  assert.equal(typeof finishWrite, 'function')
  const switched = { ...initial, stateRevision: 2, lifecycleRevision: 1,
    messages: [{ ...initial.messages[0], message: '开场乙' }] }
  runtime.sync('session', view(switched))
  assert.equal(first.removed, true)
  assert.equal(frames.length, 2)
  finishWrite({ updated: true, context: { ...initial, openingInitialization: { status: 'complete' } } })
  await tick(); await tick()
  assert.equal(replies.some(row => row.requestId === 'old-write'), false)
  assert.equal(runtime.inspect().mvuDataReady, false)
  // 任意后续楼层具有默认值，也不能让 pending 开场通过。
  const defaults = { ...switched, messages: [...switched.messages,
    { message_id: 1, role: 'user', message: '继续', variables: { stat_data: { opening: '默认' }, schema: {} } }] }
  runtime.sync('session', view(defaults))
  assert.equal(runtime.inspect().mvuDataReady, false)
  const completed = { ...switched, stateRevision: 3, openingInitialization: { status: 'complete' },
    messages: [{ ...switched.messages[0], variables: { stat_data: { opening: '乙' }, schema: {} } }] }
  runtime.sync('session', view(completed))
  assert.equal(runtime.inspect().mvuDataReady, true)
  runtime.sync('session', view({ ...completed, lifecycleRevision: 2 }))
  assert.equal(frames.length, 2)
})
