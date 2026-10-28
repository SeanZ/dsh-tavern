import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorldbookSkillProvider } from '../tavern-plugin/lib/domain/worldbook-skill-provider.js'

function fixture() {
  const entry = { ref: 'merged:42', sourceUid: 7, sourcePath: 'worldbooks/source.json', title: '城门守卫', primaryKeys: ['城门'], secondaryKeys: ['通行'], content: 'PRIVATE FULL BODY', enabled: true }
  const states = new Map(['one', 'two'].map(sessionId => [sessionId, { chat: { sessionId, worldbookStrategy: 'native-skills' }, worldBook: { view: { displayName: 'Current book', entries: [structuredClone(entry)] } } }]))
  const load = async agent => agent.background ? undefined : states.get(agent.session.id)
  const options = { load, render: async (_state, entry) => entry.content }
  const provider = createWorldbookSkillProvider(options)
  const scope = id => ({ scope: { session: { id } } })
  return { states, options, provider, scope }
}

test('worldbook native provider isolates simultaneous games and never puts full bodies into discovery', async () => {
  const { states, provider, scope } = fixture()
  const before = structuredClone([...states])
  const [one, two] = await Promise.all([provider.list(scope('one')), provider.list(scope('two'))])
  assert.equal(one.candidates.length, 1)
  assert.equal(two.candidates.length, 1)
  assert.notEqual(one.candidates[0].name, two.candidates[0].name)
  assert.equal(JSON.stringify(one).includes('PRIVATE FULL BODY'), false)
  assert.match(one.candidates[0].description, /城门守卫.*城门.*通行/)
  assert.deepEqual(one.candidates[0].metadata.worldbook, { ref: 'merged:42', sourceUid: 7, sourcePath: 'worldbooks/source.json', title: '城门守卫', book: 'Current book' })
  assert.equal(one.candidates[0].invocation.userInvocable, false)
  assert.match((await provider.get(one.candidates[0], scope('one'))).content, /merged:42 · ID 7.*\nPRIVATE FULL BODY/)
  assert.equal(await provider.get(one.candidates[0], scope('two')), undefined)
  assert.deepEqual((await provider.list({})).candidates, [])
  assert.deepEqual((await provider.list({ scope: { background: true, session: { id: 'one' } } })).candidates, [])
  assert.deepEqual((await provider.list(scope('missing'))).candidates, [])
  assert.deepEqual([...states], before, 'discovery and reads never modify source books')
})

test('reads revalidate edits, disables, deletes and strategy switches even for stale native candidates', async () => {
  const { states, provider, scope, options } = fixture()
  const state = states.get('one'), lookup = scope('one')
  const old = (await provider.list(lookup)).candidates[0]
  const entry = state.worldBook.view.entries[0]
  entry.content = 'NEW BODY'; entry.title = '新守卫'; entry.primaryKeys = ['北门']
  assert.match((await provider.get(old, lookup)).content, /新守卫.*\nNEW BODY/)
  const fresh = (await provider.list(lookup)).candidates[0]
  assert.equal(fresh.name, old.name, 'stable identity is based on game and entry ref, not mutable title')
  assert.match(fresh.description, /新守卫.*北门/)
  entry.enabled = false
  assert.deepEqual((await provider.list(lookup)).candidates, [])
  assert.equal(await provider.get(old, lookup), undefined)
  entry.enabled = true
  state.chat.worldbookStrategy = 'legacy'
  assert.deepEqual((await provider.list(lookup)).candidates, [])
  assert.equal(await provider.get(old, lookup), undefined)
  state.chat.worldbookStrategy = 'native-skills'
  const cold = createWorldbookSkillProvider(options)
  assert.match((await cold.get((await cold.list(lookup)).candidates[0], lookup)).content, /NEW BODY/)
  state.worldBook.view.entries = []
  assert.equal(await provider.get(old, lookup), undefined)
  assert.deepEqual((await cold.list(lookup)).candidates, [])
})

test('constant entries join the same skill catalog while disabled, empty and MVU rules stay out', async () => {
  const { states, provider, scope } = fixture()
  const entries = states.get('one').worldBook.view.entries
  entries.push({ ...entries[0], ref: 'constant', constant: true }, { ...entries[0], ref: 'disabled', enabled: false }, { ...entries[0], ref: 'empty', content: '  ' }, { ...entries[0], ref: 'mvu', title: '[mvu_update]变量更新规则', comment: '[mvu_update]变量更新规则' })
  const listed = await provider.list(scope('one'))
  assert.deepEqual(listed.candidates.map(item => item.locator.ref), ['merged:42', 'constant'])
  assert.equal(JSON.stringify(listed).includes('PRIVATE FULL BODY'), false)
  assert.match((await provider.get(listed.candidates[1], scope('one'))).content, /PRIVATE FULL BODY/)
  entries[1].content = 'CHANGED CONSTANT BODY'
  assert.equal((await provider.list(scope('one'))).candidates[1].description, listed.candidates[1].description)
  assert.match((await provider.get(listed.candidates[1], scope('one'))).content, /CHANGED CONSTANT BODY/)
  const empty = createWorldbookSkillProvider({ load: async () => states.get('one'), render: async () => '' })
  assert.equal(await empty.get(listed.candidates[0], scope('one')), undefined)
  const wrongGame = createWorldbookSkillProvider({ load: async () => states.get('two'), render: async () => 'leak' })
  assert.deepEqual((await wrongGame.list(scope('one'))).candidates, [])
})

test('in-flight native reads reject content made stale while template rendering is pending', async () => {
  for (const change of ['strategy', 'delete', 'disable', 'edit', 'unchanged']) {
    const { states, scope } = fixture()
    let resolveRender, enteredRender
    const entered = new Promise(resolve => { enteredRender = resolve })
    const deferred = new Promise(resolve => { resolveRender = resolve })
    const provider = createWorldbookSkillProvider({
      load: async agent => states.get(agent.session.id),
      render: async () => { enteredRender(); return deferred }
    })
    const lookup = scope('one'), state = states.get('one')
    const candidate = (await provider.list(lookup)).candidates[0]
    const pending = provider.get(candidate, lookup)
    await entered
    if (change === 'strategy') state.chat.worldbookStrategy = 'legacy'
    if (change === 'delete') state.worldBook.view.entries = []
    if (change === 'disable') state.worldBook.view.entries[0].enabled = false
    if (change === 'edit') state.worldBook.view.entries[0].content = 'EDITED WHILE RENDERING'
    resolveRender('RENDERED ORIGINAL BODY')
    const result = await pending
    if (change === 'unchanged') assert.match(result.content, /RENDERED ORIGINAL BODY/)
    else assert.equal(result, undefined, `must not deliver stale body after ${change}`)
  }
})
