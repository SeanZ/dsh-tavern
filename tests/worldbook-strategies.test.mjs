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
test('registered selectors cannot inject static skill resources or bypass disabled entries', async () => {
  const { project } = setup()
  const result = await project({ chat: { messages: [] }, card: {}, userText: '', strategy: 'native-skills', selectedRefs: ['entry:7', 'entry:9'] })
  assert.equal(result.error, null)
  assert.doesNotMatch(result.context, /OPTIONAL FULL BODY/)
  assert.equal(result.prefixContext, 'MANDATORY')
  assert.doesNotMatch(result.context, /DISABLED/)
  assert.deepEqual(result.reads, {})
})
