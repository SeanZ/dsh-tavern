import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../tavern-plugin/src/client/opening-preview.js', import.meta.url), 'utf8')

// Opening wizards call TavernHelper.generate as well as generateRaw; without a card runtime
// the preview bridge is the only TavernHelper they have (learned from XGUIMAX/dsh-tavern-wrongbook).
test('开场预览里 TavernHelper.generate 和 generateRaw 都能用，分别走 generate 与 generateRaw', async () => {
  const sent = [], listeners = []
  const parent = { postMessage: message => sent.push(message) }
  const context = vm.createContext({ parent, console, setTimeout, clearTimeout, JSON, Promise, Map, Object, Array, String, Number, Error,
    addEventListener: (type, listener) => listeners.push(listener) })
  context.window = context
  vm.runInContext(source, context)
  context.installOpeningPreviewBridge('token', { runtime: false, swipes: ['开场'], selectedIndex: 0, openingIds: ['a'], worldbook: null })
  for (const [name, method] of [['generate', 'generateTavernHelper'], ['generateRaw', 'generateTavernHelperRaw']]) {
    const pending = context.TavernHelper[name]({ user_input: '你好' })
    const request = sent.at(-1)
    assert.equal(request.method, method)
    assert.deepEqual(request.args.config, { user_input: '你好' })
    listeners.at(-1)({ source: parent, data: { type: 'dsh-tavern-helper-response', token: 'token', requestId: request.requestId, ok: true, result: { text: name + ' 回复' } } })
    assert.equal(await pending, name + ' 回复')
  }
})

// A large card book went through whole-draft reads and two whole-book uploads per write,
// past a card workshop's timeout; the script runtime's versioned, changed-entry calls stay.
test('开场预览有脚本运行时时，世界书读写交给运行时的增量接口', async () => {
  const sent = []
  const context = vm.createContext({ parent: { postMessage: message => sent.push(message) }, console, setTimeout, clearTimeout, JSON, Promise, Map, Object, Array, String, Number, Error,
    addEventListener: () => {} })
  context.window = context
  const getWorldbook = async () => [{ uid: 1 }]
  const updateWorldbookWith = async () => [{ uid: 1 }, { uid: 2 }]
  Object.assign(context, { getWorldbook, updateWorldbookWith, getChatMessages: () => [], setChatMessages: async () => {}, waitGlobalInitialized: async () => {},
    SillyTavern: { getContext: () => ({}) }, TavernHelper: { getWorldbook, updateWorldbookWith } })
  vm.runInContext(source, context)
  context.installOpeningPreviewBridge('token', { runtime: {}, preparationId: 'p', swipes: ['开场'], selectedIndex: 0, openingIds: ['a'], worldbook: { name: '书', entries: [] } })
  assert.equal(context.getWorldbook, getWorldbook)
  assert.equal(context.TavernHelper.updateWorldbookWith, updateWorldbookWith)
  assert.deepEqual(await context.TavernHelper.getWorldbook('书'), [{ uid: 1 }])
  assert.equal(sent.length, 0)
})
