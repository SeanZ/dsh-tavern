import test from 'node:test'
import assert from 'node:assert/strict'
import { helperClient } from './fixtures/helper-host-harness.mjs'
import { announceHelperDocument } from './fixtures/helper-document-handshake.mjs'
import { createTavernScriptDispatch } from '../tavern-plugin/lib/domain/tavern-script-dispatch.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

test('初始化写回失败立即拒绝等待；成功回执清除错误并恢复ready，旧文档错误不污染新局', async t => {
  const listeners = {}, replies = [], states = [], mutations = []
  const gate = createTavernScriptDispatch({ executionTimeoutMs: 5000 })
  let frame, fail = true, hold = false, rejectPending
  const hostWindow = { crypto: { randomUUID: () => 'write-test' }, setTimeout, clearTimeout,
    addEventListener(name, fn) { listeners[name] = fn }, removeEventListener() {} }
  const document = { body: { appendChild() {} }, createElement(tag) {
    if (tag === 'div') return { isConnected: true, appendChild() {}, remove() {} }
    return frame = { contentWindow: { postMessage(message) { replies.push(message) } }, listeners: {},
      addEventListener(name, fn) { this.listeners[name] = fn }, remove() {} }
  } }
  const initial = { chatId: 'chat', stateRevision: 1, lifecycleRevision: 2, chatVariables: {},
    messages: [{ message_id: 0, role: 'assistant', message: '中性开场', variables: {} }] }
  const completed = { ...initial, stateRevision: 2,
    messages: [{ ...initial.messages[0], variables: { stat_data: { score: 1 }, schema: {} } }] }
  function publish() {
    const inspection = runtime.inspect()
    gate.touch('session', 'owner', inspection.mvuDataReady === true && !inspection.initializationError, inspection.initializationError)
  }
  const runtime = helperClient.createTavernHelperScriptRuntime({ window: hostWindow, document,
    async rpc(method) {
      if (method !== 'updateTavernHelperMessages') return {}
      if (hold) return new Promise((_resolve, reject) => { rejectPending = reject })
      if (fail) throw Object.assign(new Error('消息字段发生冲突'), { code: 'DSH_TAVERN_CHAT_CONFLICT' })
      return { updated: true, context: completed }
    }, reportError() {}, resolveError() {}, mutationCoalesceMs: 0,
    onMvuLoadState(state) { states.push(state); publish() },
    onMutation(_session, method) { mutations.push(method); publish() }
  })
  t.after(() => { runtime.dispose(); gate.dispose('session') })
  runtime.sync('session', { chatId: 'chat', tavernHelper: initial,
    tavernHelperScripts: [{ id: 'companion', name: '伴随脚本', content: 'void 0' }],
    tavernMvuRuntime: { owner: 'official', assetUrl: '/bundle.js' } })
  frame.listeners.load()
  announceHelperDocument(frame, listeners.message, 'write-document')
  const token = replies.findLast(row => row.type === 'dsh-tavern-helper-context').token
  function send(requestId) {
    listeners.message({ source: frame.contentWindow, data: { token, type: 'dsh-tavern-helper-call',
      method: 'updateTavernHelperMessages', requestId, scriptId: 'companion', lifecycleRevision: 2,
      args: { messages: [{ message_id: 0, swipes_data: [{ stat_data: { score: 1 }, schema: {} }] }] } } })
  }
  listeners.message({ source: frame.contentWindow, data: { token, type: 'dsh-tavern-helper-subscriptions', ready: true, names: ['MESSAGE_RECEIVED'] } })
  await tick()
  publish()
  const waiting = assert.rejects(gate.waitUntilReady('session'), /MVU 初始变量保存失败：消息字段发生冲突/)
  send('failed')
  await tick(); await tick(); await waiting
  assert.equal(runtime.inspect().mvuDataReady, false)
  assert.match(runtime.inspect().initializationError, /消息字段发生冲突/)
  assert.equal(states.at(-1).phase, 'error')
  assert.ok(mutations.includes('initialization-failed'))
  assert.equal(replies.find(row => row.requestId === 'failed').ok, false)

  fail = false
  send('success')
  await tick(); await tick()
  assert.equal(runtime.inspect().initializationError, undefined)
  assert.equal(runtime.inspect().mvuDataReady, true)
  await gate.waitUntilReady('session')
  assert.equal(states.at(-1).phase, 'ready')
  assert.equal(replies.find(row => row.requestId === 'success').ok, true)

  hold = true
  send('old-document')
  await tick()
  assert.equal(typeof rejectPending, 'function')
  runtime.sync('another-session', { chatId: 'another-chat',
    tavernHelper: { ...completed, chatId: 'another-chat', lifecycleRevision: 3 },
    tavernHelperScripts: [{ id: 'companion', name: '伴随脚本', content: 'void 0' }],
    tavernMvuRuntime: { owner: 'official', assetUrl: '/bundle.js' } })
  rejectPending(new Error('旧文档迟到失败'))
  await tick(); await tick()
  assert.equal(runtime.inspect().initializationError, undefined)
  assert.equal(replies.some(row => row.requestId === 'old-document'), false)
})
