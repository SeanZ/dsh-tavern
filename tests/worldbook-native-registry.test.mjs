import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorldbookSkillProvider } from '../tavern-plugin/lib/domain/worldbook-skill-provider.js'

// Run against an actual DSH source checkout, including native Cordis, scope,
// registry, tool-schema validation and tool-skill's real catalog/pre-step code:
// DSH_SOURCE_ROOT=/path/to/deepseek-harness node --test tests/worldbook-native-registry.test.mjs
// This is a synthetic turn integration, not a host/LLM/browser E2E.
test('real native registry and skill tool isolate games, refresh catalogs and reject stale reads', {
  skip: !process.env.DSH_SOURCE_ROOT && 'Set DSH_SOURCE_ROOT to an actual DSH source checkout (Node 24+)',
}, async t => {
  const { nativeSkillSource } = await import('./helpers/native-skill-source.mjs')
  const native = await nativeSkillSource(process.env.DSH_SOURCE_ROOT)
  t.after(native.close)
  const ctx = new native.Context()
  const registryFiber = ctx.plugin(native.SkillRegistry)
  await registryFiber
  const promptFiber = ctx.plugin(native.SystemPrompt, {})
  await promptFiber
  t.after(() => promptFiber.dispose())
  const toolsFiber = ctx.plugin(native.ToolsService)
  await toolsFiber
  t.after(() => toolsFiber.dispose())
  t.after(() => registryFiber.dispose())

  function agent(id) {
    const events = []
    return { session: { id, surface: { nodes: [] }, get seq() { return events.length }, eventAt: index => events[index],
      append(message) { const seq = events.length; events.push({ seq, type: 'user/message', data: message }); this.surface.nodes.push(seq) }
    } }
  }
  function state(id, title, content) {
    return { chat: { sessionId: id, worldbookStrategy: 'native-skills' }, card: {}, worldBook: { view: { displayName: '测试书', entries: [
      { ref: 'book:entry-42', sourceUid: 42, sourcePath: 'worldbooks/test.json', title, primaryKeys: ['港口'], enabled: true, content }
    ] } } }
  }
  const a = agent('game-a'), b = agent('game-b'), background = agent('background-a')
  const states = new Map([[a, state('game-a', 'A 港口', 'SECRET BODY A')], [b, state('game-b', 'B 港口', 'SECRET BODY B')]])
  const provider = createWorldbookSkillProvider({ load: async scope => states.get(scope) || null, render: async (_state, entry) => entry.content })
  let invalidate
  let invalidations = 0
  const unregister = ctx.skills.registerProvider(control => { invalidate = control.invalidate; return provider })
  t.after(unregister)
  const removeCore = ctx.skills.register({ name: 'core-skill', description: 'Core skill remains available', content: 'CORE BODY', source: 'runtime' })
  t.after(removeCore)

  const listeners = []
  native.skillTool.apply({
    skills: ctx.skills, tools: ctx.tools,
    workingDirectory: { ensure: async () => '/same-workspace' },
    on: (name, listener) => { assert.equal(name, 'agent/pre-step'); listeners.push(listener) },
  })
  const signal = new AbortController().signal
  async function step(caller) {
    if (await provider.refresh(caller)) { invalidations++; invalidate() }
    const payload = { agent: caller, messages: [], signal }
    const dispatch = index => index === listeners.length ? Promise.resolve({ kind: 'enter', messages: [] }) : listeners[index](payload, () => dispatch(index + 1))
    const result = await dispatch(0)
    for (const message of result.messages) caller.session.append(message)
    return result.messages
  }
  const tool = ctx.tools.get('skill', a)
  const read = (caller, name) => tool.execute({ name }, { agent: caller, signal })
  const catalogs = await Promise.all([step(a), step(b)])
  const worldNames = catalogs.map(messages => messages[0].source.entries.find(entry => entry.name.startsWith('wb-')).name)
  assert.notEqual(...worldNames)
  for (const messages of catalogs) {
    assert.ok(messages[0].source.entries.some(entry => entry.name === 'core-skill'))
    assert.doesNotMatch(JSON.stringify(messages), /SECRET BODY|CORE BODY/)
  }
  assert.match((await read(a, worldNames[0])).content, /SECRET BODY A/)
  assert.match((await read(b, worldNames[1])).content, /SECRET BODY B/)
  await assert.rejects(read(b, worldNames[0]), /unknown or no longer available/)
  await assert.rejects(read(background, worldNames[0]), /unknown or no longer available/)
  assert.deepEqual((await ctx.skills.list()).map(skill => skill.name), ['core-skill'])
  assert.equal((await step(a)).length, 0, 'native catalog is not repeated unchanged')

  // Native cache may retain candidates; body reads always revalidate source.
  states.get(a).worldBook.view.entries[0].content = 'EDITED BODY A'
  assert.match((await read(a, worldNames[0])).content, /EDITED BODY A/)
  const beforeBodyStep = invalidations
  assert.equal((await step(a)).length, 0)
  await step(background)
  assert.equal(invalidations, beforeBodyStep, 'body-only edits and background steps do not invalidate native catalogs')
  states.get(a).worldBook.view.entries[0].enabled = false
  await assert.rejects(read(a, worldNames[0]), /unknown or no longer available/)
  const disabled = await step(a)
  assert.equal(disabled[0].source.update, true)
  assert.deepEqual(disabled[0].source.entries.map(entry => entry.name), ['core-skill'])
  assert.match((await read(b, worldNames[1])).content, /SECRET BODY B/)

  states.get(a).worldBook.view.entries[0].enabled = true
  states.get(a).worldBook.view.entries[0].title = 'Renamed A'
  const renamed = await step(a)
  assert.match(renamed[0].source.entries.find(entry => entry.name === worldNames[0]).description, /Renamed A/)
  states.get(a).chat.worldbookStrategy = 'legacy'
  await assert.rejects(read(a, worldNames[0]), /unknown or no longer available/)
  assert.deepEqual((await step(a))[0].source.entries.map(entry => entry.name), ['core-skill'])
  states.get(a).chat.worldbookStrategy = 'native-skills'
  assert.ok((await step(a))[0].source.entries.some(entry => entry.name === worldNames[0]))

  // New agent object models cold resume; same game identity gets its own scope cache.
  const cold = agent('game-a')
  states.set(cold, states.get(a))
  assert.ok((await step(cold))[0].source.entries.some(entry => entry.name === worldNames[0]))
  states.get(a).worldBook.view.entries = []
  await assert.rejects(read(cold, worldNames[0]), /unknown or no longer available/)
  assert.deepEqual((await step(cold))[0].source.entries.map(entry => entry.name), ['core-skill'])
  const concurrent = Array.from({ length: 6 }, (_, index) => agent(`parallel-${index}`))
  concurrent.forEach((caller, index) => states.set(caller, state(caller.session.id, `Parallel ${index}`, `PRIVATE ${index}`)))
  for (let round = 0; round < 3; round++) {
    concurrent.forEach((caller, index) => { states.get(caller).worldBook.view.entries[0].title = `Round ${round} / ${index}` })
    const results = await Promise.all(concurrent.map(step))
    const names = []
    for (const [index, messages] of results.entries()) {
      assert.equal(messages.length, 1, 'each concurrent changed game publishes its native catalog')
      const entries = messages[0].source.entries
      assert.ok(entries.some(entry => entry.name === 'core-skill'))
      const world = entries.filter(entry => entry.name.startsWith('wb-'))
      assert.equal(world.length, 1)
      assert.match(world[0].description, new RegExp(`Round ${round} / ${index}`))
      assert.doesNotMatch(JSON.stringify(messages), /PRIVATE/)
      names.push(world[0].name)
    }
    assert.equal(new Set(names).size, concurrent.length)
    assert.ok((await Promise.all(concurrent.map(step))).every(messages => messages.length === 0))
  }
  unregister()
  assert.deepEqual((await ctx.skills.list({ scope: b })).map(skill => skill.name), ['core-skill'])
})
