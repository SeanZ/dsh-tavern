import test from 'node:test'
import assert from 'node:assert/strict'
import { clearRetiredSearchProvider } from '../tavern-plugin/lib/domain/retired-search-provider.js'
import { applyTavernSettingsPatch, presentTavernSettings } from '../tavern-plugin/lib/domain/tavern-settings.js'

for (const provider of [undefined, 'deepseek-official', 'custom', 'tavern-search']) test(`only retire Tavern provider: ${provider}`, async () => {
  const calls = []
  const settings = { describe: () => [{ ns: 'web', revision: 7, user: { searchProvider: provider } }], mutate: async (...args) => calls.push(args) }
  assert.equal(await clearRetiredSearchProvider(settings), provider === 'tavern-search')
  assert.deepEqual(calls, provider === 'tavern-search' ? [['web', [{ op: 'unset', path: ['searchProvider'] }], 7]] : [])
})
test('absent host namespace is harmless; stale revision errors are not hidden', async () => {
  assert.equal(await clearRetiredSearchProvider({ describe: () => [] }), false)
  await assert.rejects(clearRetiredSearchProvider({ describe: () => [{ ns: 'web', user: { searchProvider: 'tavern-search' } }], mutate: async () => { throw Error('revision conflict') } }), /revision conflict/)
})
test('old Tavern search preferences neither surface nor survive a settings save', () => {
  const old = { webAccess: { sources: ['bing'], fetchEnabled: false }, untouched: 1 }
  assert.equal(Object.hasOwn(presentTavernSettings(old, {}), 'webAccess'), false)
  const next = applyTavernSettingsPatch(old, { webAccess: { sources: ['ddg'] } })
  assert.equal(Object.hasOwn(next, 'webAccess'), false)
  assert.equal(next.untouched, 1)
})
