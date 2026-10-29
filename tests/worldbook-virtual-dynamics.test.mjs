import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyWorldbookEntry } from '../tavern-plugin/lib/domain/worldbook-entry-classification.js'
import { createForegroundWorldbook } from '../tavern-plugin/lib/domain/foreground-worldbook.js'
import { projectVirtualWorldbookPrefix } from '../tavern-plugin/lib/domain/worldbook-virtual-state.js'

const entry = (ref, content, constant = true, extra = {}) => ({ ref, content, constant, enabled: true, ...extra })
function fixture(entries, render = async text => ({ ok: true, text, scopes: {} })) {
  const worldBook = { view: { entries } }
  const project = createForegroundWorldbook({ bound: async () => worldBook, runtime: async () => ({ render }), globalVariables: async () => ({}) })
  const chat = { sessionId: 'one', cardPath: 'card', worldbookStrategy: 'native-skills', messages: [], macroState: { local: { weather: 'sun' } } }
  const run = async (requestKey = 'request-1', userText = '') => {
    const result = await project({ chat, card: { name: 'hero' }, requestKey, userText })
    if (result.virtualState) chat.worldBookVirtualState = result.virtualState
    return result
  }
  return { worldBook, chat, project, run }
}
test('four-way classifier does not execute expressions and conservatively handles unknown syntax', () => {
  assert.equal(classifyWorldbookEntry(entry('a', 'plain')).kind, 'static-constant')
  assert.equal(classifyWorldbookEntry(entry('a', 'plain', false)).kind, 'static-skill')
  assert.equal(classifyWorldbookEntry(entry('a', '{{getvar::weather}}')).kind, 'dynamic-constant')
  assert.equal(classifyWorldbookEntry(entry('a', '<%= x %>', false)).kind, 'dynamic-conditional')
  for (const body of ['<!-- <%= sideEffect() %> -->', '<%% escaped %>', '<% unterminated', '{{setvar::x::1}}', '{{getvar::x+=1}}', '{{random::a::b}}', '@@generate\nx', '[RENDER:BEFORE]', '{{unknown}}']) {
    const classified = classifyWorldbookEntry(entry('a', body))
    assert.equal(classified.dynamic, true, body)
    assert.equal(classified.nativeFallback, true, body)
  }
  assert.deepEqual(classifyWorldbookEntry(entry('a', '{{getvar::weather}}')).dependencies, [{ scope: 'local', key: 'weather' }])
})
test('static constants preserve exact body and are refreshed outside message history', async () => {
  const f = fixture([entry('a', '  exact\r\nbody  '), entry('b', 'secret', false, { primaryKeys: ['secret'] })])
  const first = await f.run('one', 'secret')
  assert.equal(first.staticPrefix, '  exact\r\nbody  ')
  assert.match(first.context, /可能相关的世界书条目/)
  assert.doesNotMatch(first.context, /secret/)
  assert.deepEqual(f.chat.messages, [])
  f.worldBook.view.entries[0].content = 'edited'
  assert.equal(projectVirtualWorldbookPrefix(f.worldBook, f.chat).staticPrefix, 'edited')
})
test('dependency refresh emits only changed renders and snapshots survive serialization', async () => {
  const f = fixture([entry('a', '{{getvar::weather}}')])
  assert.equal((await f.run()).context, '')
  assert.equal(f.chat.worldBookVirtualState.entries.a.text, 'sun')
  assert.equal((await f.run('request-2')).context, '')
  f.chat.macroState.local.weather = 'rain'
  const changed = await f.run('request-3')
  assert.equal(changed.context, '')
  assert.doesNotMatch(changed.context, /rain/)
  assert.equal(changed.virtualState.entries.a.text, 'rain')
  assert.deepEqual(changed.changedVirtualRefs, ['a'])
  const restarted = JSON.parse(JSON.stringify(f.chat))
  assert.equal(projectVirtualWorldbookPrefix(f.worldBook, restarted).snapshots, '')
  assert.equal(projectVirtualWorldbookPrefix(f.worldBook, restarted, { restoreRefs: [] }).snapshots, '')
  restarted.sessionId = 'other'
  assert.equal(projectVirtualWorldbookPrefix(f.worldBook, restarted).snapshots, '')
  f.worldBook.view.entries[0].content = '{{getvar::new}}'
  assert.equal(projectVirtualWorldbookPrefix(f.worldBook, f.chat).snapshots, '')
})
test('native side-effect controller and random output execute once across convergence and retry', async () => {
  let calls = 0
  const f = fixture([entry('a', '<% sideEffect() %>'), entry('b', '{{char}}', false)], async () => {
    calls++; return { ok: true, text: 'sample-' + calls, scopes: {}, activationRequests: [{ ref: 'b', force: true }] }
  })
  const first = await f.run()
  assert.equal(calls, 1)
  assert.match(first.context, /sample-1/)
  assert.doesNotMatch(first.context, /hero/)
  assert.equal(first.virtualState.entries.b.text, 'hero')
  await f.run()
  assert.equal(calls, 1)
  const next = await f.run('request-2')
  assert.equal(calls, 2)
  assert.match(next.context, /sample-2/)
})
test('dynamic entries retain native conditions while static keywords produce title-only hints every round', async () => {
  let calls = 0
  const f = fixture([entry('dynamic', '<%= weather %>', false, { primaryKeys: ['weather'] }), entry('static', 'secret', false, { primaryKeys: ['weather'] })], async () => {
    calls++; return { ok: true, text: 'weather output', scopes: {} }
  })
  assert.equal((await f.run('one', 'nothing')).context, '')
  assert.equal(calls, 0)
  const second = await f.run('two', 'weather')
  assert.match(second.context, /可能相关的世界书条目/)
  assert.doesNotMatch(second.context, /weather output/)
  assert.match(second.context, /条目 static/)
  assert.doesNotMatch(second.context, /secret/)
  assert.deepEqual(second.reads, {})
  assert.equal(calls, 1)
  const third = await f.run('three', 'weather')
  assert.match(third.context, /可能相关的世界书条目/)
  assert.doesNotMatch(third.context, /weather output|secret/)
  assert.deepEqual(third.changedVirtualRefs, [])
  assert.equal(calls, 2)
  f.worldBook.view.entries[0].enabled = false
  assert.equal(projectVirtualWorldbookPrefix(f.worldBook, f.chat).snapshots, '')
})

test('native projection-local setters refresh read-only dependencies without repeated execution', async () => {
  const f = fixture([entry('setter', '{{setvar::weather::rain}}', true, { order: 10 }), entry('reader', '{{getvar::weather}}', true, { order: 20 })])
  await f.run('one')
  assert.equal(f.chat.worldBookVirtualState.entries.reader.text, 'rain')
  f.worldBook.view.entries[0].content = '{{setvar::weather::snow}}'
  await f.run('two')
  assert.equal(f.chat.worldBookVirtualState.entries.reader.text, 'snow')
  assert.equal((await f.run('three')).context, '')
})
test('empty native output is cached and a new execution request is a fresh random occasion', async () => {
  let calls = 0
  const f = fixture([entry('a', '<% emptySideEffect() %>')], async () => { calls++; return { ok: true, text: '', scopes: {} } })
  assert.equal((await f.run()).context, '')
  await f.run()
  assert.equal(calls, 1)
  await f.run('two')
  assert.equal(calls, 2)
  f.project.dispose()
  await f.run('three')
  assert.equal(calls, 3)
})
test('deleted or disabled entries cannot restore snapshots', async () => {
  const f = fixture([entry('a', '{{getvar::weather}}')])
  await f.run()
  f.worldBook.view.entries = []
  assert.equal(projectVirtualWorldbookPrefix(f.worldBook, f.chat).prefixContext, '')
  const result = await f.run('two')
  assert.deepEqual(result.virtualState.entries, {})
})
test('activation passes reuse native side-effect scopes before newly activated templates', async () => {
  const entries = [entry('controller', '<% controller %>', true, { order: 10 }), entry('dependent', '<%= scope %>', false, { order: 20 })]
  const worldBook = { view: { entries } }
  let batches = 0, calls = 0
  const runtime = {
    render: async (_body, input) => { calls++; return { ok: true, text: input.scopes.local?.x || 'MISSING', scopes: input.scopes } },
    renderProjections: async () => { batches++; return [{ ok: true, text: 'controller', scopes: { local: { x: 'value' } }, activationRequests: [{ ref: 'dependent', force: true }] }] }
  }
  const project = createForegroundWorldbook({ bound: async () => worldBook, runtime: async () => runtime, globalVariables: async () => ({}) })
  const result = await project({ chat: { sessionId: 'scope', messages: [], worldbookStrategy: 'native-skills' }, card: {}, requestKey: 'one' })
  assert.equal(result.error, null)
  assert.doesNotMatch(result.context, /value/)
  assert.equal(result.virtualState.entries.dependent.text, 'value')
  assert.equal(batches, 1)
  assert.equal(calls, 1)
})

test('source edits re-render but deduplicate identical output by entry identity and render hash', async () => {
  let calls = 0
  const f = fixture([entry('a', '<%= first %>')], async () => { calls++; return { ok: true, text: 'same output', scopes: {} } })
  assert.equal((await f.run('one')).context, '')
  assert.equal(f.chat.worldBookVirtualState.entries.a.text, 'same output')
  f.worldBook.view.entries[0].content = '<%= second %>'
  assert.equal((await f.run('two')).context, '')
  assert.equal(calls, 2)
  assert.equal(projectVirtualWorldbookPrefix(f.worldBook, f.chat).snapshots, '')
})
test('persisted same-request native projection does not repeat side effects after executor restart', async () => {
  let calls = 0
  const entries = [entry('a', '<% sideEffect() %>')]
  const render = async () => { calls++; return { ok: true, text: 'sample', scopes: {} } }
  const first = fixture(entries, render)
  await first.run('same-request')
  const restarted = fixture(entries, render)
  Object.assign(restarted.chat, JSON.parse(JSON.stringify(first.chat)))
  assert.equal((await restarted.run('same-request')).context, '')
  assert.equal(calls, 1)
  await restarted.run('new-request')
  assert.equal(calls, 2)
})
test('mutating runtime state in the same execution request does not execute controllers again', async () => {
  let calls = 0
  const f = fixture([entry('a', '<% sideEffect() %>')], async () => { calls++; return { ok: true, text: 'once', scopes: {} } })
  await f.run('one')
  f.chat.variables = { changed: true }
  f.chat.macroState.local.weather = 'rain'
  await f.run('one')
  assert.equal(calls, 1)
  await f.run('two')
  assert.equal(calls, 2)
})
test('editing one source in a request invalidates that entry but not other executed controllers', async () => {
  const calls = new Map()
  const f = fixture([entry('a', '<%= a %>'), entry('b', '<%= b %>')], async body => {
    calls.set(body, (calls.get(body) || 0) + 1)
    return { ok: true, text: body, scopes: {} }
  })
  await f.run('one')
  f.worldBook.view.entries[0].content = '<%= changed %>'
  await f.run('one')
  assert.equal(calls.get('<%= a %>'), 1)
  assert.equal(calls.get('<%= b %>'), 1)
  assert.equal(calls.get('<%= changed %>'), 1)
})
test('hasvar dependency distinguishes absent keys from explicit null', async () => {
  const f = fixture([entry('a', '{{hasvar::present}}')])
  await f.run('one')
  assert.equal(f.chat.worldBookVirtualState.entries.a.text, 'false')
  f.chat.macroState.local.present = null
  await f.run('two')
  assert.equal(f.chat.worldBookVirtualState.entries.a.text, 'true')
})
test('new earlier setters survive cached controller replay and refresh pure readers', async () => {
  const entries = [entry('a', '<% controller %>', true, { order: 10 }), entry('b', '{{setvar::weather::snow}}', false, { order: 0 }), entry('c', '{{getvar::weather}}', true, { order: 20 })]
  let calls = 0
  const f = fixture(entries, async () => { calls++; return { ok: true, text: 'controller', scopes: {}, activationRequests: [{ ref: 'b', force: true }] } })
  const result = await f.run()
  assert.equal(result.error, null)
  assert.doesNotMatch(result.context, /snow/)
  assert.equal(result.virtualState.entries.c.text, 'snow')
  assert.doesNotMatch(result.context, /sun/)
  assert.equal(result.macroState.local.weather, 'snow')
  assert.equal(calls, 1)
})
test('nonforce selection cannot bypass native dynamic keyword conditions', async () => {
  const f = fixture([entry('a', '{{char}}', false, { primaryKeys: ['secret'] })])
  const result = await f.project({ chat: f.chat, card: { name: 'hero' }, requestKey: 'one', selectedRefs: ['a'], userText: 'unrelated' })
  assert.equal(result.context, '')
})
test('nonempty to empty data renders notify withdrawal without restoring a body', async () => {
  let output = 'old setting'
  const f = fixture([entry('a', '<%= output %>')], async () => ({ ok: true, text: output, scopes: {} }))
  await f.run('one')
  output = ''
  const changed = await f.run('two')
  assert.equal(changed.context, '', 'file notification hook owns withdrawal notices')
  assert.deepEqual(changed.changedVirtualRefs, ['a'])
  assert.equal(f.chat.worldBookVirtualState.entries.a.text, '')
  assert.equal(projectVirtualWorldbookPrefix(f.worldBook, f.chat).snapshots, '')
  assert.equal((await f.run('three')).context, '')
})
test('macro getter values with nested runtime syntax use the request occasion', async () => {
  const f = fixture([entry('a', '{{getvar::nested}}')])
  f.chat.macroState.local.nested = '{{incvar::count}}'
  f.chat.macroState.local.count = 0
  const first = await f.run('one')
  assert.equal(first.macroState.local.count, 1)
  const second = await f.run('two')
  assert.equal(second.macroState.local.count, 1)
})
test('whole-book preprocessing is guarded once per request and decorator edits are explicitly deferred', async () => {
  let preparations = 0
  const worldBook = { view: { entries: [entry('controller', '@@generate\n<% controller %>'), entry('plain', 'plain', false)] } }
  const runtime = { render: async () => ({ ok: true, text: 'controller', scopes: {} }),
    prepareWorldbook: async entries => { preparations++; return { entries, scopes: {} } } }
  const project = createForegroundWorldbook({ bound: async () => worldBook, runtime: async () => runtime, globalVariables: async () => ({}) })
  const chat = { sessionId: 'preprocess', worldbookStrategy: 'native-skills', messages: [] }
  await project({ chat, card: {}, requestKey: 'one' })
  worldBook.view.entries[1].content = 'edited plain'
  await project({ chat, card: {}, requestKey: 'one' })
  assert.equal(preparations, 1)
  worldBook.view.entries[0].content = '@@generate\n<% changed %>'
  const deferred = await project({ chat, card: {}, requestKey: 'one' })
  assert.equal(preparations, 1)
  assert.ok(deferred.diagnostics.some(item => item.code === 'preprocessing-edit-deferred-to-next-request'))
  await project({ chat, card: {}, requestKey: 'two' })
  assert.equal(preparations, 2)
})
test('native preprocessing visibility revokes previously rendered snapshots', async () => {
  let visible = true
  const worldBook = { view: { entries: [entry('controller', '@@if condition\n<%= value %>')] } }
  const runtime = { render: async () => ({ ok: true, text: 'visible setting', scopes: {} }),
    prepareWorldbook: async entries => ({ entries: visible ? entries : [], scopes: {} }) }
  const project = createForegroundWorldbook({ bound: async () => worldBook, runtime: async () => runtime, globalVariables: async () => ({}) })
  const chat = { sessionId: 'visibility', worldbookStrategy: 'native-skills', messages: [] }
  const first = await project({ chat, card: {}, requestKey: 'one' })
  chat.worldBookVirtualState = first.virtualState
  assert.match(projectVirtualWorldbookPrefix(worldBook, chat).snapshots, /visible setting/)
  visible = false
  const second = await project({ chat, card: {}, requestKey: 'two' })
  chat.worldBookVirtualState = second.virtualState
  assert.deepEqual(second.virtualState.entries, {})
  assert.equal(projectVirtualWorldbookPrefix(worldBook, chat).snapshots, '')
})
test('persisted preprocessing guard survives executor restart in the same explicit request', async () => {
  let preparations = 0
  const worldBook = { view: { entries: [entry('controller', '@@generate\n<% controller %>')] } }
  const runtime = { render: async () => ({ ok: true, text: 'controller', scopes: {} }),
    prepareWorldbook: async entries => { preparations++; return { entries, scopes: {} } } }
  const create = () => createForegroundWorldbook({ bound: async () => worldBook, runtime: async () => runtime, globalVariables: async () => ({}) })
  const chat = { sessionId: 'preprocess-restart', worldbookStrategy: 'native-skills', messages: [] }
  const first = await create()({ chat, card: {}, requestKey: 'one' })
  chat.worldBookVirtualState = JSON.parse(JSON.stringify(first.virtualState))
  await create()({ chat, card: {}, requestKey: 'one' })
  assert.equal(preparations, 1)
  await create()({ chat, card: {}, requestKey: 'two' })
  assert.equal(preparations, 2)
})
test('preprocessing restart cache stores sparse overrides without duplicating unchanged static bodies', async () => {
  const staticBody = 'UNIQUE STATIC ORIGINAL BODY '.repeat(100)
  const worldBook = { view: { entries: [entry('controller', '@@generate\n<% controller %>'), entry('static', staticBody, false)] } }
  const runtime = { render: async () => ({ ok: true, text: 'controller', scopes: {} }),
    prepareWorldbook: async entries => ({ entries, scopes: {} }) }
  const project = createForegroundWorldbook({ bound: async () => worldBook, runtime: async () => runtime, globalVariables: async () => ({}) })
  const result = await project({ chat: { sessionId: 'sparse', worldbookStrategy: 'native-skills', messages: [] }, card: {}, requestKey: 'one' })
  assert.ok(result.virtualState.preprocessing)
  assert.equal(JSON.stringify(result.virtualState.preprocessing).includes(staticBody), false)
  assert.equal(result.virtualState.preprocessing.prepared.overrides.static?.content, undefined)
})
test('nested effectful getter executes only once across activation convergence', async () => {
  const f = fixture([entry('a', '<% controller %>', true, { order: 10 }), entry('b', '{{char}}', false), entry('c', '{{getvar::nested}}', true, { order: 20 })], async () => ({ ok: true, text: 'controller', scopes: {}, activationRequests: [{ ref: 'b', force: true }] }))
  f.chat.macroState.local.nested = '{{incvar::count}}'
  f.chat.macroState.local.count = 0
  const result = await f.run('one')
  assert.equal(result.macroState.local.count, 1)
  assert.equal(result.virtualState.entries.c.text, '1')
})
test('native activation group sampling is stable on cold same-request restart', async () => {
  const entries = Array.from({ length: 10 }, (_, n) => entry('group-' + n, '{{char}} choice ' + n, false, { group: 'exclusive', primaryKeys: ['topic'] }))
  const f = fixture(entries)
  f.chat.worldBookRandomState = { turn: 0, seed: 'deterministic-group-test' }
  const first = await f.run('one', 'topic')
  assert.equal(first.changedVirtualRefs.length, 1)
  const restarted = fixture(entries)
  Object.assign(restarted.chat, JSON.parse(JSON.stringify(f.chat)))
  const second = await restarted.run('one', 'topic')
  assert.deepEqual(second.log.entries.map(entry => entry.ref), first.log.entries.map(entry => entry.ref))
  const winners = new Set()
  for (let n = 0; n < 8; n++) winners.add((await restarted.run('next-' + n, 'topic')).log.entries[0].ref)
  assert.ok(winners.size > 1)
})
test('static prefix fails closed until native preprocessor visibility is current', async () => {
  const { eligibleVirtualSourceEntries } = await import('../tavern-plugin/lib/domain/worldbook-virtual-state.js')
  const worldBook = { view: { entries: [entry('controller', '@@generate\n<% controller %>'), entry('static', 'SECRET STATIC')] } }
  let show = false
  const runtime = { render: async () => ({ ok: true, text: '', scopes: {} }),
    prepareWorldbook: async entries => ({ entries: entries.filter(entry => entry.ref !== 'static' || show), scopes: {} }) }
  const project = createForegroundWorldbook({ bound: async () => worldBook, runtime: async () => runtime, globalVariables: async () => ({}) })
  const chat = { sessionId: 'static-visibility', worldbookStrategy: 'native-skills', messages: [] }
  assert.deepEqual(eligibleVirtualSourceEntries(worldBook, chat), [])
  let result = await project({ chat, card: {}, requestKey: 'one' })
  chat.worldBookVirtualState = result.virtualState
  assert.equal(projectVirtualWorldbookPrefix(worldBook, chat).staticPrefix, '')
  show = true
  result = await project({ chat, card: {}, requestKey: 'two' })
  chat.worldBookVirtualState = result.virtualState
  assert.equal(projectVirtualWorldbookPrefix(worldBook, chat).staticPrefix, 'SECRET STATIC')
  worldBook.view.entries[1].content = 'EDITED STATIC'
  assert.deepEqual(eligibleVirtualSourceEntries(worldBook, chat), [])
  result = await project({ chat, card: {}, requestKey: 'three' })
  chat.worldBookVirtualState = result.virtualState
  assert.equal(projectVirtualWorldbookPrefix(worldBook, chat).staticPrefix, 'EDITED STATIC')
  worldBook.view.entries[1].enabled = false
  assert.equal(projectVirtualWorldbookPrefix(worldBook, chat).staticPrefix, '')
})
for (const scope of ['local', 'global']) test(`macro ${scope} dependency reads actual macro scope, not identically named EJS variables`, async () => {
  const suffix = scope === 'global' ? 'globalvar' : 'var'
  const entries = [entry('exists', `{{has${suffix}::present}}`), entry('read', `{{get${suffix}::shadow}}`)]
  const worldBook = { view: { entries } }
  const templates = { present: null, shadow: 'same value' }
  const project = createForegroundWorldbook({ bound: async () => worldBook,
    runtime: async () => ({ render: async text => ({ ok: true, text, scopes: {} }) }),
    globalVariables: async () => templates })
  const chat = { sessionId: 'shadow-' + scope, worldbookStrategy: 'native-skills', messages: [], variables: templates,
    macroState: { local: {}, global: {} } }
  const first = await project({ chat, card: {}, requestKey: 'one' })
  assert.equal(first.virtualState.entries.exists.text, 'false')
  assert.equal(first.virtualState.entries.read.text, '')
  chat.worldBookVirtualState = first.virtualState
  chat.macroState[scope].present = null
  chat.macroState[scope].shadow = 'same value'
  const second = await project({ chat, card: {}, requestKey: 'two' })
  assert.equal(second.virtualState.entries.exists.text, 'true')
  assert.equal(second.virtualState.entries.read.text, 'same value')
  assert.deepEqual(new Set(second.changedVirtualRefs), new Set(['exists', 'read']))
})

test('runtime controllers keep their injected and restored output while display templates do not', async () => {
  const f = fixture([entry('controller', '<% executeRule() %>'), entry('data', '<%= state %>')], async text =>
    ({ ok: true, text: text.includes('executeRule') ? 'CONTROLLER RULE' : 'PRIVATE DATA', scopes: {} }))
  const result = await f.run('one')
  assert.match(result.context, /CONTROLLER RULE/)
  assert.doesNotMatch(result.context, /PRIVATE DATA/)
  const prefix = projectVirtualWorldbookPrefix(f.worldBook, f.chat).prefixContext
  assert.match(prefix, /CONTROLLER RULE/)
  assert.doesNotMatch(prefix, /PRIVATE DATA/)
})

test('mvu_plot is an audience label, not evidence of executable code', async () => {
  const { isWorldbookRuntimeEntry } = await import('../tavern-plugin/lib/domain/worldbook-entry-classification.js')
  const plain = { enabled: true, constant: false, comment: '[mvu_plot]地方志', content: '# 地方志\n河口有渡船。' }
  assert.equal(classifyWorldbookEntry(plain).kind, 'static-skill')
  assert.equal(isWorldbookRuntimeEntry(plain), false)
  assert.equal(classifyWorldbookEntry({ ...plain, constant: true }).kind, 'dynamic-constant', 'preserve constant delivery and existing system prefix')
  for (const extra of [{ content: '<% setvar("a", 1) %>' }, { comment: '[mvu_update]结算' }, { comment: '[mvu_other]未知规则' }]) {
    assert.equal(classifyWorldbookEntry({ ...plain, ...extra }).dynamic, true)
    assert.equal(isWorldbookRuntimeEntry({ ...plain, ...extra }), true)
  }
})
