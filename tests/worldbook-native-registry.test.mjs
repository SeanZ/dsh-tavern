import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorldbookSkillProvider } from '../tavern-plugin/lib/domain/worldbook-skill-provider.js'
import { virtualHash, virtualScope } from '../tavern-plugin/lib/domain/worldbook-virtual-state.js'
import { installWorldbookSkillRead } from '../tavern-plugin/lib/domain/worldbook-skill-read.js'

// Opt-in official-source integration: native registry, Cordis, skill catalog,
// read definition and full tool dispatch/permission/schema/render pipeline.
// Session and working-directory data are synthetic; reference IO uses real files. No model calls.
test('native skill and read pipeline isolates real per-game files and refreshes lifecycle state', {
  skip: !process.env.DSH_SOURCE_ROOT && !process.env.DSH_RUNTIME_ROOT && 'Set DSH_RUNTIME_ROOT to installed node_modules or DSH_SOURCE_ROOT to an official checkout',
}, async t => {
  const native = process.env.DSH_RUNTIME_ROOT
    ? await (await import('./helpers/native-skill-runtime.mjs')).nativeSkillRuntime(process.env.DSH_RUNTIME_ROOT)
    : await (await import('./helpers/native-skill-source.mjs')).nativeSkillSource(process.env.DSH_SOURCE_ROOT)
  t.after(native.close)
  const ctx = new native.Context()
  for (const plugin of [native.SkillRegistry, native.SystemPrompt, native.ToolsService]) {
    const fiber = ctx.plugin(plugin, {})
    await fiber
    t.after(() => fiber.dispose())
  }
  const signal = new AbortController().signal
  function agent(id) {
    const events = []
    return { session: { id, surface: { nodes: [] }, get seq() { return events.length }, eventAt: i => events[i],
      append(message) { const seq = events.length; events.push({ seq, type: 'user/message', data: message }); this.surface.nodes.push(seq) }
    } }
  }
  function state(id, title, content) {
    return { chat: { sessionId: id, id: id + '-chat', worldbookStrategy: 'native-skills' }, card: {}, worldBook: { view: { displayName: '测试书', entries: [
      { ref: 'book:entry-42', sourceUid: 42, sourcePath: 'worldbooks/test.json', title, primaryKeys: ['港口'], enabled: true, content }
    ] } } }
  }
  const a = agent('game-a'), b = agent('game-b'), background = agent('background')
  const states = new Map([[a, state(a.session.id, 'A 港口', 'SECRET BODY A')], [b, state(b.session.id, 'B 港口', 'SECRET BODY B')]])
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-worldbook-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const provider = createWorldbookSkillProvider({ inlineTokenBudget: 0, directory, load: async scope => states.get(scope) || null })
  let resourceReads = 0
  const authorizeRead = provider.authorizeRead
  provider.authorizeRead = (...args) => { resourceReads++; return authorizeRead(...args) }
  t.after(() => provider.dispose())
  let invalidate
  const unregister = ctx.skills.registerProvider(control => { invalidate = control.invalidate; return provider })
  t.after(unregister)
  t.after(ctx.skills.register({ name: 'core-skill', description: 'Core remains', content: 'CORE BODY', source: 'runtime' }))
  const workingDirectory = { ensure: async () => '/same-workspace' }
  const listeners = []
  native.skillTool.apply({ skills: ctx.skills, tools: ctx.tools, workingDirectory,
    on: (name, listener) => { assert.equal(name, 'agent/pre-step'); listeners.push(listener) } })
  let filesystemReads = 0
  native.readTool.applyReadTool({ tools: ctx.tools, systemPrompt: ctx.systemPrompt, workingDirectory,
    emit: (...args) => ctx.emit(...args),
    fs: {
      resolve: async path => ({ displayPath: path, targetKey: path }),
      stat: async target => { const s = await fs.stat(target.displayPath); return { type: 'file', size: s.size, version: String(s.mtimeMs) } },
      readText: async target => { filesystemReads++; return fs.readFile(target.displayPath, 'utf8') },
      processPath: target => target.displayPath,
    },
  }, { limit: 2000, maxLineLength: 2000, maxBytes: 50 * 1024, streamMinSize: 10 * 1024 * 1024 })
  t.after(installWorldbookSkillRead(ctx, provider))
  let callId = 0
  const execute = (caller, name, args, customSignal = signal) => ctx.tools.execute({ agent: caller, signal: customSignal, callId: `native-${++callId}`, name, arguments: args })
  const read = (caller, path, extras = {}) => execute(caller, 'read', { file_path: path, ...extras })
  const output = result => result.content.map(block => block.text || '').join('\n')
  function success(result) { assert.equal(result.isError, false, output(result)); return result.value }
  function failure(result) { assert.equal(result.isError, true, output(result)); return output(result) }
  async function step(caller) {
    if (await provider.refresh(caller)) invalidate()
    const payload = { agent: caller, messages: [], turn: 1, step: 1, signal }
    const dispatch = i => i === listeners.length ? Promise.resolve({ kind: 'enter', messages: [] }) : listeners[i](payload, () => dispatch(i + 1))
    const result = await dispatch(0)
    for (const message of result.messages) caller.session.append(message)
    return result.messages
  }
  async function discover(caller) {
    const messages = await step(caller)
    const catalogMessage = messages[0] || [...caller.session.surface.nodes].reverse().map(seq => caller.session.eventAt(seq).data).find(m => m.source?.entries)
    const entries = catalogMessage.source.entries
    assert.ok(entries.some(entry => entry.name === 'core-skill'))
    assert.doesNotMatch(JSON.stringify(messages), /SECRET BODY|CORE BODY/)
    const name = entries.find(entry => entry.name !== 'core-skill').name
    const skill = success(await execute(caller, 'skill', { name }))
    assert.doesNotMatch(skill.content, /SECRET BODY/)
    assert.match(skill.content, /references\//)
    assert.doesNotMatch(skill.content, /INDEX\.md/)
    const base = skill.resourceBase.path
    const file = skill.content.match(/\]\((references\/[^)]+)\)/)[1]
    return { name, base, entry: base + '/' + file }
  }
  const [ra, rb] = await Promise.all([discover(a), discover(b)])
  assert.notEqual(ra.name, rb.name)
  const body = await read(a, ra.entry)
  assert.deepEqual(success(body).lines, [{ number: 1, text: 'SECRET BODY A' }])
  assert.match(output(body), /SECRET BODY A/, 'native output renderer ran on bridge value')
  assert.equal(body.meta.path, ra.entry, 'native presentation metadata was produced')
  assert.equal(filesystemReads, 1, 'generated references reach the native filesystem reader')
  for (const caller of [b, background, undefined]) failure(await read(caller, ra.entry))
  failure(await execute(b, 'skill', { name: ra.name }))
  failure(await execute(background, 'skill', { name: ra.name }))
  assert.deepEqual((await ctx.skills.list()).map(item => item.name), ['core-skill'])
  assert.equal((await step(a)).length, 0)
  const ordinary = path.join(directory, '..', path.basename(directory) + '-ordinary.txt')
  await fs.writeFile(ordinary, 'ORDINARY FILE\nsecond line\n')
  t.after(() => fs.rm(ordinary, { force: true }))
  success(await read(a, ordinary, { offset: 2, limit: 1 }))
  assert.equal(filesystemReads, 2, 'ordinary reads retain real native body')
  const beforeDenied = resourceReads
  const deny = ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'read' ? { kind: 'deny', reason: 'policy denies read' } : next())
  assert.match(failure(await read(a, ra.entry)), /policy denies read/)
  assert.equal(resourceReads, beforeDenied, 'pre-execute denial prevents the resource adapter from running')
  deny()
  const aborted = new AbortController(); aborted.abort()
  failure(await execute(a, 'read', { file_path: ra.entry }, aborted.signal))
  failure(await read(a, ra.base + '/../INDEX.md'))
  // Native reader owns its own paging limits.
  failure(await read(a, ra.entry, { offset: 0 }))
  failure(await read(a, ra.entry, { offset: '1' }))
  assert.equal(filesystemReads, 2)
  // A leased background task shares its parent's physical files, never another game's.
  states.set(background, { ...states.get(a), authorizedSessionId: background.session.id })
  assert.equal((await discover(background)).base, ra.base)
  assert.match(output(await read(background, ra.entry)), /SECRET BODY A/)
  failure(await read(background, rb.entry))
  states.delete(background)
  failure(await read(background, ra.entry))



  states.get(a).worldBook.view.entries[0].content = 'EDITED BODY A\nsecond'
  const edited = await discover(a)
  Object.assign(ra, edited)
  assert.deepEqual(success(await read(a, ra.entry, { offset: 2, limit: 1 })).lines, [{ number: 2, text: 'second' }])
  await step(a) // semantic body features may legitimately change clustered routing metadata
  assert.equal((await step(a)).length, 0, 'unchanged edited state does not repeat catalog')
  states.get(a).worldBook.view.entries[0].enabled = false
  failure(await read(a, ra.entry))
  failure(await execute(a, 'skill', { name: ra.name }))
  const disabled = await step(a)
  assert.equal(disabled[0].source.update, true)
  assert.deepEqual(disabled[0].source.entries.map(item => item.name), ['core-skill'])
  assert.match(output(await read(b, rb.entry)), /SECRET BODY B/)
  states.get(a).worldBook.view.entries[0].enabled = true
  await step(a)
  states.get(a).chat.worldbookStrategy = 'legacy'
  failure(await read(a, ra.entry))
  assert.deepEqual((await step(a))[0].source.entries.map(item => item.name), ['core-skill'])
  states.get(a).chat.worldbookStrategy = 'native-skills'
  await step(a)
  // Compaction removes the old catalog from the visible surface, not history.
  a.session.surface.nodes = []
  const restored = await step(a)
  assert.equal(restored[0].source.update, true)
  assert.ok(restored[0].source.entries.some(item => item.name === ra.name))
  assert.equal((await step(a)).length, 0)
  const cold = agent('game-a'); states.set(cold, states.get(a))
  assert.equal((await discover(cold)).name, ra.name)
  success(await read(cold, ra.entry))
  states.get(a).chat.id = 'different-chat'
  success(await read(a, ra.entry)) // Chat identity no longer owns the source bundle.
  states.get(a).chat.id = 'game-a-chat'
  states.get(a).worldBook.view.entries = []
  failure(await read(cold, ra.entry))
  assert.deepEqual((await step(cold))[0].source.entries.map(item => item.name), ['core-skill'])
  const concurrent = Array.from({ length: 6 }, (_, i) => agent(`parallel-${i}`))
  concurrent.forEach((caller, i) => states.set(caller, state(caller.session.id, `Port ${i}`, `SECRET BODY ${i}`)))
  // Publish all catalogs before invalidating the shared native registry; an
  // unrelated scope must not invalidate another in-flight discovery.
  await Promise.all(concurrent.map(caller => provider.refresh(caller)))
  invalidate()
  const resources = await Promise.all(concurrent.map(discover))
  assert.equal(new Set(resources.map(item => item.name)).size, concurrent.length)
  const reads = await Promise.all(concurrent.map((caller, i) => read(caller, resources[i].entry)))
  reads.forEach((result, i) => assert.equal(success(result).lines[0].text, `SECRET BODY ${i}`))
  for (let i = 0; i < concurrent.length; i++) failure(await read(concurrent[i], resources[(i + 1) % concurrent.length].entry))
  assert.ok((await Promise.all(concurrent.map(step))).every(messages => messages.length === 0))
  // Native skill listeners were registered before Tavern's preparation hook.
  // They await next(), so a later hook must invalidate early cached discovery
  // after runtime visibility is established, before the native catalog unwinds.
  const controlled = agent('controlled-game')
  const controlledState = state(controlled.session.id, 'Visible port', 'VISIBLE ORIGINAL')
  controlledState.worldBook.view.entries.push(
    { ref: 'hidden-ref', sourceUid: 99, title: 'HIDDEN ROUTE', primaryKeys: ['hidden'], enabled: true, content: 'HIDDEN ORIGINAL' },
    { ref: 'controller', constant: true, enabled: true, content: '@@generate_before\n<% throw new Error("MUST NOT EXECUTE IN DISCOVERY") %>' },
  )
  states.set(controlled, controlledState)
  let allowedRefs = ['book:entry-42']
  let preparations = 0
  listeners.push(async ({ agent: caller }, next) => {
    if (caller === controlled) {
      preparations++
      // Deliberately populate the real registry cache before preparing the
      // runtime-owned visibility snapshot. Discovery must fail closed here.
      const before = await ctx.skills.snapshot({ scope: caller, cwd: '/same-workspace', signal })
      if (preparations === 1) assert.deepEqual(before.skills.map(item => item.name), ['core-skill'])
      // Later caches may still contain old summaries, but get/read revalidate
      // visibility and the invalidation below replaces them before publication.
      controlledState.chat.worldBookVirtualState = {
        schemaVersion: 1, scope: virtualScope(controlledState.chat), entries: {},
        visibility: { version: virtualHash(controlledState.worldBook.view.entries), refs: [...allowedRefs] },
      }
      // Mirrors projectForegroundWorldbook's invalidation after runtime prep.
      invalidate()
    }
    return next()
  })
  const firstControlled = await discover(controlled)
  assert.equal(preparations, 1, 'first native request sees preparation in this very step')
  const visibleIndex = success(await read(controlled, firstControlled.base + '/SKILL.md'))
  assert.doesNotMatch(JSON.stringify(visibleIndex), /hidden-ref|HIDDEN ROUTE|controller/)
  assert.equal(success(await read(controlled, firstControlled.entry)).lines[0].text, 'VISIBLE ORIGINAL')
  controlledState.worldBook.view.entries[0].content = 'EDIT REVOKES OLD VISIBILITY'
  failure(await read(controlled, firstControlled.entry))
  failure(await execute(controlled, 'skill', { name: firstControlled.name }))
  allowedRefs = ['hidden-ref']
  const nextControlled = await discover(controlled)
  assert.equal(preparations, 2)
  const nextIndex = success(await read(controlled, nextControlled.base + '/SKILL.md'))
  assert.doesNotMatch(JSON.stringify(nextIndex), /book:entry-42|Visible port|controller/)
  assert.equal(success(await read(controlled, nextControlled.entry)).lines[0].text, 'HIDDEN ORIGINAL')
  failure(await read(controlled, firstControlled.entry))
  failure(await read(background, nextControlled.entry))
  unregister()
  assert.deepEqual((await ctx.skills.list({ scope: b })).map(item => item.name), ['core-skill'])
  const inlineProvider = createWorldbookSkillProvider({ directory: path.join(directory, 'inline'), load: async scope => states.get(scope) || null })
  t.after(() => inlineProvider.dispose())
  t.after(ctx.skills.registerProvider(() => inlineProvider))
  const inlineCandidate = (await ctx.skills.list({ scope: b })).find(item => item.name !== 'core-skill')
  const inlined = success(await execute(b, 'skill', { name: inlineCandidate.name }))
  assert.match(inlined.content, /SECRET BODY B/)
  assert.doesNotMatch(inlined.content, /references\//)
  assert.doesNotMatch(output(await execute(b, 'skill', { name: inlineCandidate.name })), /<!-- worldbook-entry:/)
  await assert.rejects(fs.access(path.join(inlined.resourceBase.path, 'references')))

})
