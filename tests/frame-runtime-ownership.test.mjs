import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const clientSource = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')

async function loadClient() {
  let descriptor
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(value) {
          descriptor = value
        },
      },
    },
    console,
  }
  vm.runInNewContext(clientSource, sandbox)
  return descriptor.factory(function () {
    return {}
  })
}

const client = await loadClient()

test('持久面板跨轮复用文档时，清掉旧轮排队报告，新报告归属当前轮', async () => {
  const listeners = new Map(),
    timers = new Map(),
    calls = []
  let timerId = 0
  const host = {
    document: null,
    sessionStorage: { getItem() {} },
    setTimeout(fn) {
      timers.set(++timerId, fn)
      return timerId
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    addEventListener(name, fn) {
      listeners.set(name, fn)
    },
    removeEventListener(name) {
      listeners.delete(name)
    },
  }
  const props = {
    sessionId: 's1',
    content: '<p>持久面板</p>',
    turn: 2,
    partIndex: 0,
    panelId: 'status',
    persistent: true,
    eager: true,
  }
  const lifecycle = client.createTavernMessageFrameLifecycle(props, {
    window: host,
    async rpc(method, args, session) {
      calls.push({ method, args, session })
    },
  })
  const doc = lifecycle.snapshot().visibleDocument,
    frame = { contentWindow: { postMessage() {} } }
  doc.ref(frame)
  const stop = lifecycle.start(() => {})
  const report = (value) =>
    listeners.get('message')({
      source: frame.contentWindow,
      data: { type: 'dsh-tavern-frame-runtime', token: doc.token, runtime: { dom: '', console: [value] } },
    })
  report('旧轮')
  lifecycle.update({ ...props, turn: 3 })
  assert.equal(lifecycle.snapshot().visibleDocument, doc)
  report('当前轮')
  for (const fn of Array.from(timers.values())) fn()
  await Promise.resolve()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.turn, 3)
  assert.equal(calls[0].session, 's1')
  assert.deepEqual(Array.from(calls[0].args.runtime.console), ['当前轮'])
  stop()
})
