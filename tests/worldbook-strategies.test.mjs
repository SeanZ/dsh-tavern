import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorldbookStrategies } from '../tavern-plugin/lib/domain/worldbook-strategies.js'
import { createForegroundWorldbook } from '../tavern-plugin/lib/domain/foreground-worldbook.js'
import { inspectWorldBookDocument } from '../tavern-plugin/lib/domain/worldbook-resource.js'

const runtime = { render: async text => ({ ok: true, text, scopes: {} }) }
function setup(extra = {}) {
  const document = { entries: {
    4: { uid: 4, comment: '常驻', constant: true, content: 'MANDATORY' },
    7: { uid: 7, comment: '秘密', key: ['秘密'], content: 'OPTIONAL FULL BODY' },
    9: { uid: 9, comment: '停用', constant: true, disable: true, content: 'DISABLED' },
    12: { uid: 12, comment: '强制', content: 'FORCED' }
  } }
  const worldBook = { document, view: inspectWorldBookDocument(document), ...extra }
  let screened = 0
  const project = createForegroundWorldbook({ bound: async () => worldBook, runtime: async () => runtime,
    globalVariables: async () => ({}), filterCandidates: async () => { screened++; throw Error('should not screen') } })
  return { project, worldBook, screened: () => screened }
}
test('strategy registry migrates legacy to retrieval, registers and unloads without mutating saved selection', async () => {
  const registry = createWorldbookStrategies({ nativeSkills: async () => 'native' })
  assert.equal(await registry.project({ chat: {} }), 'native')
  assert.equal(await registry.project({ chat: { worldbookStrategy: 'legacy' } }), 'native')
  assert.equal(registry.has('legacy'), false)
  assert.throws(() => registry.register({ id: 'legacy', label: 'Legacy', project() {} }), /已停用/)
  assert.equal(await registry.project({ chat: { worldbookStrategy: 'native-skills' } }), 'native')
  const chat = { worldbookStrategy: 'plugin-demo' }
  const dispose = registry.register({ id: 'plugin-demo', label: 'Demo', project: async () => 'plugin' })
  assert.equal(await registry.project({ chat }), 'plugin')
  assert.equal(registry.has('plugin-demo'), true)
  dispose(); dispose()
  assert.equal(await registry.project({ chat }), 'native')
  assert.equal(chat.worldbookStrategy, 'plugin-demo')
  assert.throws(() => registry.register({ id: 'native-skills', label: 'collision', project() {} }), /已注册/)
})
test('native strategy never injects optional bodies or invokes screening and preserves legacy reads', async () => {
  const { project, screened } = setup()
  const reads = { 'entry:7': { turn: 1, fingerprint: 'old', kind: 'screened' } }
  const chat = { worldbookStrategy: 'native-skills', worldBookReads: reads, messages: [], backgroundTasks: { worldbookScreening: true } }
  const result = await project({ chat, card: {}, userText: '秘密', purpose: 'prefilter' })
  assert.equal(result.error, null)
  assert.equal(result.prefixContext, 'MANDATORY')
  assert.doesNotMatch(result.context, /OPTIONAL|DISABLED/)
  assert.deepEqual(result.reads, reads)
  assert.deepEqual(chat.worldBookReads, reads)
  assert.equal(screened(), 0)
})
test('native strategy keeps even explicitly forced static entries in skills and leaves legacy cooldowns untouched', async () => {
  const { project } = setup({ pluginActivationRequests: [{ ref: 'entry:12', force: true, sourceRef: 'plugin' }] })
  const chat = { worldbookStrategy: 'native-skills', messages: [] }
  const native = await project({ chat, card: {}, userText: '秘密' })
  assert.doesNotMatch(native.context, /FORCED/)
  assert.doesNotMatch(native.context, /OPTIONAL/)
  const legacy = await project({ chat, card: {}, userText: '秘密', strategy: 'legacy' })
  const defaultLegacy = await project({ chat: { ...chat, worldbookStrategy: undefined }, card: {}, userText: '秘密' })
  assert.deepEqual(legacy.refs, defaultLegacy.refs)
  assert.equal(legacy.context, defaultLegacy.context)
  assert.doesNotMatch(legacy.context, /OPTIONAL|FORCED/)
})
test('mandatory template activations converge without promoting unrelated keyword entries', async () => {
  const { worldBook } = setup()
  worldBook.view.entries[0].content = '<% controller %>'
  const project = createForegroundWorldbook({ bound: async () => worldBook,
    runtime: async () => ({ render: async () => ({ ok: true, text: 'CONTROL', scopes: {}, activationRequests: [{ ref: 'entry:12', force: true }] }) }),
    globalVariables: async () => ({}) })
  const result = await project({ chat: { worldbookStrategy: 'native-skills', messages: [] }, card: {}, userText: '秘密' })
  assert.equal(result.error, null)
  assert.match(result.context, /CONTROL/)
  assert.doesNotMatch(result.context, /FORCED/)
  assert.doesNotMatch(result.context, /OPTIONAL/)
  assert.deepEqual(result.refs, [])
})
test('registered selectors cannot inject static skill resources or bypass disabled entries', async () => {
  const { project } = setup()
  const result = await project({ chat: { messages: [] }, card: {}, userText: '', strategy: 'native-skills', selectedRefs: ['entry:7', 'entry:9'] })
  assert.equal(result.error, null)
  assert.doesNotMatch(result.context, /OPTIONAL FULL BODY/)
  assert.equal(result.prefixContext, 'MANDATORY')
  assert.doesNotMatch(result.context, /DISABLED/)
  assert.deepEqual(result.reads, {})
})
