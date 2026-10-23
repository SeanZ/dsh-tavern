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

test('普通可信消息 frame 替换和卸载时释放自身的宿主事件，保留其它 frame 事件', () => {
  const listeners = new Map(),
    removed = []
  class OldRealm {}
  class NewRealm {}
  const oldHandler = new OldRealm(),
    newHandler = new NewRealm()
  const handlers = [oldHandler, newHandler]
  const host = {
    document: null,
    sessionStorage: { getItem() {} },
    setTimeout,
    clearTimeout,
    addEventListener(name, fn) {
      listeners.set(name, fn)
    },
    removeEventListener(name) {
      listeners.delete(name)
    },
    jQuery: {
      hasData: (target) => target === host,
      _data: () => ({ click: handlers.map((handler) => ({ handler, origType: 'click' })) }),
      event: {
        remove(_target, _type, handler) {
          removed.push(handler)
          handlers.splice(handlers.indexOf(handler), 1)
        },
      },
    },
  }
  const lifecycle = client.createTavernMessageFrameLifecycle(
    { sessionId: 's1', content: '<p>普通消息</p>', turn: 2, trustedCardMode: true, eager: true },
    { window: host },
  )
  const doc = lifecycle.snapshot().visibleDocument
  doc.ref({ contentWindow: { Function: OldRealm, postMessage() {} } })
  const stop = lifecycle.start(() => {})
  doc.ref(null)
  assert.deepEqual(removed, [oldHandler])
  assert.deepEqual(handlers, [newHandler])
  doc.ref({ contentWindow: { Function: NewRealm, postMessage() {} } })
  stop()
  assert.deepEqual(removed, [oldHandler, newHandler])
})
