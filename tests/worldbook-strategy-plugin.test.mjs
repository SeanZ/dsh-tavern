import test from 'node:test'
import assert from 'node:assert/strict'
import { createTavernPluginApi } from '../tavern-plugin/lib/plugin-api.js'
import { createWorldbookStrategies } from '../tavern-plugin/lib/domain/worldbook-strategies.js'

function setup(select, options = {}) {
  const registry = createWorldbookStrategies({ legacy: async () => 'legacy', nativeSkills: async () => 'native' })
  const worldBook = { view: { entries: [
    { ref: 'entry:1', title: 'Allowed', content: 'body', enabled: true },
    { ref: 'entry:2', title: 'Disabled', content: 'hidden', enabled: false }
  ] } }
  const effects = []
  const ctx = { fiber: { name: 'test/plugin@one' }, effect: register => { const dispose = register(); effects.push(dispose); return dispose } }
  const api = createTavernPluginApi({ ctx, worldbookStrategies: registry,
    resolveGame: async sessionId => ({ sessionId }), worldbookStrategyEntries: async () => worldBook,
    projectWorldbookSelection: async (input, refs) => refs === null ? 'legacy' : refs,
    logger: { warn() {} }, ...options })
  const dispose = api.service.worldbookStrategy({ name: 'choose', label: 'Choose', select })
  const id = registry.list().find(row => row.id.startsWith('plugin-')).id
  return { registry, worldBook, effects, dispose, input: { chat: { sessionId: 'game-1', worldbookStrategy: id } } }
}
test('plugin selection is namespaced, cloned and constrained to enabled references', async () => {
  const h = setup(input => {
    assert.equal(input.gameId, 'game-1')
    assert.equal(input.chat, undefined)
    assert.deepEqual(input.entries.map(entry => entry.ref), ['entry:1'])
    input.entries[0].content = 'mutation'
    return ['entry:1', 'entry:1']
  })
  assert.deepEqual(await h.registry.project(h.input), ['entry:1'])
  assert.equal(h.worldBook.view.entries[0].content, 'body')
  assert.equal(h.effects.length, 1)
  h.dispose()
  assert.equal(await h.registry.project(h.input), 'legacy')
})
test('invalid references and plugin failures fall back without erasing selection', async () => {
  for (const select of [() => ['entry:2'], () => ['unknown'], () => 'entry:1', () => { throw Error('broken') }]) {
    const h = setup(select)
    assert.equal(await h.registry.project(h.input), 'legacy')
    assert.match(h.input.chat.worldbookStrategy, /^plugin-/)
  }
})
test('card-scoped plugin cannot inspect another game and unload revokes pending callback', async () => {
  let called = false
  const scoped = setup(() => { called = true; return [] }, {
    cardScope: async () => new Map([['test/plugin@one', { cards: ['/cards/own.json'] }]]), cardPathOf: async () => '/cards/other.json'
  })
  assert.equal(await scoped.registry.project(scoped.input), 'legacy')
  assert.equal(called, false)
  let release, started
  const pending = new Promise(resolve => { started = resolve })
  const h = setup(() => { started(); return new Promise(resolve => { release = resolve }) })
  const result = h.registry.project(h.input)
  await pending; h.dispose(); release(['entry:1'])
  assert.equal(await result, 'legacy')
})
