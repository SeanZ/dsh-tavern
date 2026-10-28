import { mkdtempSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorldbookSkillProvider, nameWorldbookSkillDirectories } from '../tavern-plugin/lib/domain/worldbook-skill-provider.js'
import { compileWorldbookSkillClusters } from '../tavern-plugin/lib/domain/worldbook-skill-clustering.js'
import { installWorldbookSkillRead, nativeWorldbookReadAvailable } from '../tavern-plugin/lib/domain/worldbook-skill-read.js'

function outputDirectory(t) { const dir = mkdtempSync(path.join(os.tmpdir(), 'wb-skills-')); t.after(() => fs.rm(dir, {recursive:true,force:true})); return dir }
function fixture(t, extra = {}) {
  const entry = { ref: 'merged:42', sourceUid: 7, sourcePath: 'worldbooks/source.json', title: '城门守卫', primaryKeys: ['城门'], secondaryKeys: ['通行'], content: '  PRIVATE FULL BODY\n\n原文末尾  ', enabled: true }
  const states = new Map(['one', 'two'].map(sessionId => [sessionId, { chat: { id: sessionId, sessionId, cardPath: 'cards/a.json', worldbookStrategy: 'native-skills' }, worldBook: { view: { displayName: 'Current book', entries: [structuredClone(entry)] } } }]))
  const scopes = new Map([...states.keys()].map(id => [id, { session: { id } }]))
  const results = new Map()
  const catalog = { async update(key, entries) { const next = compileWorldbookSkillClusters(entries, { previousClusters: results.get(key)?.clusters }); results.set(key, next); return next }, dispose(key) { if (key) results.delete(key); else results.clear() } }
  const provider = createWorldbookSkillProvider({ inlineTokenBudget: 0, directory: outputDirectory(t), load: async scope => scope.background ? null : states.get(scope.session.id), catalog, ...extra })
  t.after(() => provider.dispose())
  const lookup = id => ({ scope: scopes.get(id) || { session: { id } } })
  const candidate = async id => (await provider.list(lookup(id))).candidates[0]
  const paths = async id => { const skill = await candidate(id); const base = skill.resourceBase.path; const entry = (await provider.inspect(lookup(id))).clusters.find(c => c.name === skill.name).entries[0].path; return { skill, base, entry } }
  return { states, scopes, provider, lookup, candidate, paths }
}

test('cluster catalog and SKILL contain metadata only; entry resources preserve exact original bytes', async t => {
  const f = fixture(t), before = structuredClone([...f.states])
  const a = await f.paths('one'), b = await f.paths('two')
  assert.equal(a.skill.name, 'cheng-men-shou-wei')
  assert.equal(a.skill.name, b.skill.name)
  assert.equal(a.base, b.base)
  const guide = await f.provider.get(a.skill, f.lookup('one'))
  assert.doesNotMatch(JSON.stringify(await f.provider.list(f.lookup('one'))), /PRIVATE FULL BODY/)
  assert.doesNotMatch(guide.content, /PRIVATE FULL BODY/)
  assert.match(guide.content, /references\/城门守卫.md/)
  assert.doesNotMatch(guide.content, /INDEX.md|阅读顺序/)
  await assert.rejects(fs.access(path.join(a.base, 'INDEX.md')))
  assert.equal(await fs.readFile(a.entry, 'utf8'), f.states.get('one').worldBook.view.entries[0].content)
  assert.equal(await f.provider.readResource(a.entry, f.lookup('one')), f.states.get('one').worldBook.view.entries[0].content)
  assert.deepEqual([...f.states], before)
})

test('all reads revalidate current game, source edits, disabled entries, strategy and card switches', async t => {
  const f = fixture(t), a = await f.paths('one'), state = f.states.get('one'), entry = state.worldBook.view.entries[0]
  assert.equal(await f.provider.get(a.skill, f.lookup('two')), undefined)
  assert.equal(await f.provider.readResource(a.entry, f.lookup('two')), entry.content)
  assert.equal(await f.provider.readResource(a.entry, { scope: { session: { id: 'one' }, background: true } }), undefined)
  assert.deepEqual((await f.provider.list({})).candidates, [])
  entry.content = 'EDITED EXACT\n'; const edited = await f.paths('one'); assert.equal(await f.provider.readResource(edited.entry, f.lookup('one')), entry.content)
  assert.equal((await f.candidate('one')).name, a.skill.name)
  entry.enabled = false; assert.equal(await f.provider.readResource(a.entry, f.lookup('one')), undefined)
  entry.enabled = true; state.chat.worldbookStrategy = 'legacy'; assert.equal(await f.provider.readResource(a.entry, f.lookup('one')), undefined)
  state.chat.worldbookStrategy = 'native-skills'; state.chat.cardPath = 'cards/b.json'; assert.equal(await f.provider.readResource(a.entry, f.lookup('one')), undefined)
  state.chat.cardPath = 'cards/a.json'; state.worldBook.view.entries = []; assert.equal(await f.provider.get(a.skill, f.lookup('one')), undefined)
})

test('only static nonconstant entries are skills; discovery never calls templates', async t => {
  let executions = 0
  const f = fixture(t, { render() { executions++; throw Error('must not execute') } }), entries = f.states.get('one').worldBook.view.entries
  entries.push({ ...entries[0], ref: 'constant', constant: true }, { ...entries[0], ref: 'dynamic', content: '<%= Math.random() %>' }, { ...entries[0], ref: 'macro', content: '{{getvar::x}}' }, { ...entries[0], ref: 'disabled', enabled: false }, { ...entries[0], ref: 'mvu', title: '[mvu_update]变量更新规则', comment: '[mvu_update]变量更新规则' })
  const a = await f.paths('one')
  assert.deepEqual(a.skill.metadata.worldbook.refs, ['merged:42'])
  await f.provider.get(a.skill, f.lookup('one')); await f.provider.readResource(a.entry, f.lookup('one'))
  assert.equal(executions, 0)
})

test('edit during asynchronous compilation cannot publish stale content or stale permission', async t => {
  const f = fixture(t)
  let first = true, started, resume
  const entered = new Promise(resolve => { started = resolve }), blocked = new Promise(resolve => { resume = resolve })
  const provider = createWorldbookSkillProvider({ inlineTokenBudget: 0, directory: outputDirectory(t), load: async () => f.states.get('one'), catalog: { async update(_key, entries) { const output = compileWorldbookSkillClusters(entries); if (first) { first = false; started(); await blocked } return output }, dispose() {} } })
  t.after(() => provider.dispose())
  const pending = provider.list(f.lookup('one')); await entered
  f.states.get('one').worldBook.view.entries[0].constant = true; resume()
  assert.deepEqual((await pending).candidates, [])
})

test('unavailable native resource reader means no unusable skills advertised', async t => {
  const f = fixture(t, { resourcesAvailable: () => false })
  assert.deepEqual((await f.provider.list(f.lookup('one'))).candidates, [])
})

const readTool = { parameters: { type: 'object', properties: { file_path: {} } }, output: { schema: { properties: { path: {}, lines: {}, totalLines: {} } } } }
test('read guard delegates real files to native IO and denies cross-game and legacy paths', async t => {
  const f = fixture(t), a = await f.paths('one')
  let handler, nativeReads = 0
  const ctx = { tools: { get: () => readTool }, on(name, fn) { assert.equal(name, 'tools/execute'); handler = fn } }
  assert.equal(nativeWorldbookReadAvailable(ctx.tools, f.scopes.get('one')), true)
  installWorldbookSkillRead(ctx, f.provider)
  const run = (file, agent = f.scopes.get('one')) => handler({ name: 'read', arguments: { file_path: file }, agent }, async () => { nativeReads++; return fs.readFile(file, 'utf8') })
  assert.equal(await run(a.entry), f.states.get('one').worldBook.view.entries[0].content)
  assert.equal(nativeReads, 1)
  f.states.get('two').chat.cardPath = 'cards/different.json'
  await assert.rejects(run(a.entry, f.scopes.get('two')), /no longer available/)
  await assert.rejects(run(a.base + '/../SKILL.md'), /no longer available/)
  await assert.rejects(run(a.entry, null), /current game/)
  await assert.rejects(run('/__tavern_worldbook__/old/INDEX.md'), /real files/)
  assert.equal(nativeReads, 1)
})

test('source snapshots share bundles across chats and survive chat deletion without overwriting', async t => {
  const f = fixture(t), a = await f.paths('one'), b = await f.paths('two'), state = f.states.get('one')
  assert.equal(a.entry, b.entry)
  const original = state.worldBook.view.entries[0].content
  state.worldBook.view.entries[0].content = 'UPDATED\n'
  const edited = await f.paths('one')
  assert.notEqual(edited.entry, a.entry)
  assert.equal(await fs.readFile(edited.entry, 'utf8'), 'UPDATED\n')
  assert.equal(await f.provider.readResource(a.entry, f.lookup('two')), original)
  assert.equal(await f.provider.readResource(edited.entry, f.lookup('two')), undefined)
  await f.provider.removeChat(state.chat)
  assert.equal(await f.provider.readResource(b.entry, f.lookup('two')), original)
  await fs.access(edited.entry)
  state.worldBook.view.entries[0].enabled = false
  assert.equal(await f.provider.readResource(edited.entry, f.lookup('one')), undefined)
})

test('derived-file edits are restored; symlink escapes are denied', async t => {
  const f = fixture(t), a = await f.paths('one')
  const original = f.states.get('one').worldBook.view.entries[0].content
  await fs.unlink(a.entry)
  assert.equal(await f.provider.readResource(a.entry, f.lookup('one')), original)
  await fs.writeFile(a.entry, 'NOT AUTHORITATIVE')
  assert.equal(await f.provider.readResource(a.entry, f.lookup('one')), original)
  const outside = path.join(outputDirectory(t), 'outside.md')
  await fs.writeFile(outside, 'PRIVATE')
  await fs.unlink(a.entry); await fs.symlink(outside, a.entry)
  await assert.rejects(f.provider.authorizeRead(a.entry, f.lookup('one')), /symlink/)
  assert.equal(await fs.readFile(outside, 'utf8'), 'PRIVATE')
})

test('pre-step refresh rejects promptly when its caller aborts pending compilation', async t => {
  const f = fixture(t)
  let complete
  const pending = new Promise(resolve => { complete = resolve })
  const provider = createWorldbookSkillProvider({ inlineTokenBudget: 0, directory: outputDirectory(t), load: async () => f.states.get('one'), catalog: { update: () => pending, dispose() {} } })
  t.after(() => provider.dispose())
  const abort = new AbortController()
  const refreshing = provider.refresh(f.scopes.get('one'), { signal: abort.signal })
  await new Promise(resolve => setImmediate(resolve))
  abort.abort(new Error('stopped'))
  await assert.rejects(refreshing, /stopped/)
  complete({ clusters: [] })
})

test('mounting read for native gameplay does not grant ordinary filesystem access', async t => {
  const f = fixture(t)
  let handler
  installWorldbookSkillRead({ tools: { get: () => readTool }, on(_name, fn) { handler = fn } }, f.provider, { virtualOnly: async scope => scope === f.scopes.get('one') })
  const run = agent => handler({ name: 'read', arguments: { file_path: '/private.txt' }, agent }, () => 'ordinary')
  await assert.rejects(run(f.scopes.get('one')), /limited to its generated/)
  assert.equal(await run(f.scopes.get('two')), 'ordinary')
})

test('preprocessing-controlled books require current runtime visibility, never execute scripts during discovery', async t => {
  const f = fixture(t), state = f.states.get('one')
  state.worldBook.view.entries.push({ ref: 'controller', content: '@@generate_before\n<% filterEntries() %>', constant: true, enabled: true })
  assert.deepEqual((await f.provider.list(f.lookup('one'))).candidates, [])
  const { virtualHash, virtualScope } = await import('../tavern-plugin/lib/domain/worldbook-virtual-state.js')
  state.chat.worldBookVirtualState = { schemaVersion: 1, scope: virtualScope(state.chat), entries: {}, visibility: { version: virtualHash(state.worldBook.view.entries), refs: ['merged:42'] } }
  assert.equal((await f.provider.list(f.lookup('one'))).candidates.length, 1)
  state.chat.worldBookVirtualState.visibility.refs = []
  assert.deepEqual((await f.provider.list(f.lookup('one'))).candidates, [])
  state.chat.worldBookVirtualState.visibility.refs = ['merged:42']
  state.worldBook.view.entries[0].content = 'new source invalidates old visibility'
  assert.deepEqual((await f.provider.list(f.lookup('one'))).candidates, [])
})

test('inspector shares actual catalog, excludes bodies and revalidates entry paths', async t => {
  const f = fixture(t)
  const view = await f.provider.inspect(f.lookup('one'))
  assert.equal(view.clusters[0].name, (await f.candidate('one')).name)
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE FULL BODY/)
  const entry = view.clusters[0].entries[0]
  assert.equal(await f.provider.readResource(entry.path, f.lookup('one')), f.states.get('one').worldBook.view.entries[0].content)
  assert.equal(await f.provider.readResource(entry.path, f.lookup('two')), f.states.get('two').worldBook.view.entries[0].content)
  f.states.get('one').chat.worldbookStrategy = 'legacy'
  assert.equal(await f.provider.inspect(f.lookup('one')), null)
})


test('readable reference names avoid duplicate IDs, traversal and oversized filenames', async t => {
  const f = fixture(t), state = f.states.get('one'), entry = state.worldBook.view.entries[0]
  entry.title = '../相同/标题?'
  state.worldBook.view.entries.push({ ...entry, ref: 'another-book:42' })
  const catalog = await f.provider.inspect(f.lookup('one'))
  const entries = catalog.clusters.flatMap(c => c.entries)
  assert.equal(new Set(entries.map(e => e.path.toLowerCase())).size, 2)
  for (const e of entries) {
    assert.match(e.path, /references.*相同-标题/)
    assert.equal(await fs.readFile(e.path, 'utf8'), entry.content)
  }
  entry.title = '标题'.repeat(200); entry.sourceUid = '标识'.repeat(200)
  const long = (await f.provider.inspect(f.lookup('one'))).clusters.flatMap(c => c.entries).find(e => e.ref === entry.ref)
  assert.ok(Buffer.byteLength(path.basename(long.path)) < 255)
  assert.equal(await fs.readFile(long.path, 'utf8'), entry.content)
})

test('failed staging leaves the previous bundle intact and removes temporary files', async t => {
  const { createWorldbookSkillFiles } = await import('../tavern-plugin/lib/domain/worldbook-skill-files.js')
  const root = outputDirectory(t), files = createWorldbookSkillFiles(root), key = 'a'.repeat(20)
  await files.sync(key, new Map([['主题/SKILL.md', 'previous']]))
  await assert.rejects(files.sync(key, new Map([['../escape.md', 'bad']])), /Invalid/)
  assert.equal(await fs.readFile(path.join(files.directory(key), '主题/SKILL.md'), 'utf8'), 'previous')
  assert.deepEqual(await fs.readdir(root), [key])
})


test('folder names omit internal IDs and resolve case-insensitive collisions deterministically', () => {
  const input = [{ id: 'topic-b', title: '武市 · 拓本' }, { id: 'topic-a', title: '武市 · 拓本' }, { id: 'topic-c', title: '武市、拓本--2' }, { id: 'topic-d', title: '独立分类' }]
  const named = nameWorldbookSkillDirectories(input)
  assert.deepEqual(named.map(c => c.directoryName), ['武市、拓本--2', '武市、拓本', '武市、拓本--2--2', '独立分类'])
  assert.deepEqual(nameWorldbookSkillDirectories([...input].reverse()).reverse(), named)
  assert.ok(named.every(c => !c.directoryName.includes('topic-')))
})


test('short groups inline exact originals; crossing 2000 estimated tokens switches files in both directions', async t => {
  const f = fixture(t, { inlineTokenBudget: 2000 })
  const state = f.states.get('one'), entry = state.worldBook.view.entries[0]
  const first = (await f.provider.inspect(f.lookup('one'))).clusters[0]
  assert.equal(first.inline, true)
  assert.equal(first.entries[0].path, path.join(first.directory, 'SKILL.md'))
  assert.ok(first.guide.includes(entry.content))
  assert.equal(await f.provider.readEntry(entry.ref, f.lookup('one')), entry.content)
  assert.equal(await f.provider.readEntry('missing', f.lookup('one')), undefined)
  const loaded = await f.provider.get(await f.candidate('one'), f.lookup('one'))
  assert.ok(loaded.content.includes(entry.content))
  await assert.rejects(fs.access(path.join(first.directory, 'references')))
  entry.content = 'x'.repeat(8000)
  let view = (await f.provider.inspect(f.lookup('one'))).clusters[0]
  assert.equal(view.estimatedTokens, 2000); assert.equal(view.inline, true)
  entry.content += 'x'
  view = (await f.provider.inspect(f.lookup('one'))).clusters[0]
  assert.equal(view.inline, false); assert.equal(view.estimatedTokens, 2001)
  assert.doesNotMatch(view.guide, /xxxx/)
  const oldReference = view.entries[0].path
  assert.equal(await fs.readFile(oldReference, 'utf8'), entry.content)
  entry.content = '  短原文\n\n末尾空格  '
  view = (await f.provider.inspect(f.lookup('one'))).clusters[0]
  assert.equal(view.inline, true); assert.ok(view.guide.includes(entry.content))
  await fs.access(oldReference) // Another chat may still use this source snapshot.
  assert.equal(await f.provider.readResource(oldReference, f.lookup('one')), undefined)
})

test('inline admission counts the whole group rather than each short member', async t => {
  const catalog = { async update(_key, entries) { return { clusters: entries.length ? [{ id: 'topic-group', title: 'group', keywords: [], refs: entries.map(e=>e.ref) }] : [] } }, dispose() {} }
  const f = fixture(t, { inlineTokenBudget: 2000, catalog })
  const entries = f.states.get('one').worldBook.view.entries
  entries[0].content = 'x'.repeat(4000)
  entries.push({...entries[0],ref:'second',sourceUid:8,content:'y'.repeat(4000)})
  let view=(await f.provider.inspect(f.lookup('one'))).clusters[0]
  assert.equal(view.inline,true)
  assert.ok(view.guide.includes(entries[0].content) && view.guide.includes(entries[1].content))
  entries[1].content += 'y'
  view=(await f.provider.inspect(f.lookup('one'))).clusters[0]
  assert.equal(view.inline,false)
  for(const entry of view.entries) assert.match(entry.path,/references/)
})

test('readable scope directories survive restart, disambiguate games and migrate hash folders', async t => {
  const { createWorldbookSkillFiles } = await import('../tavern-plugin/lib/domain/worldbook-skill-files.js')
  const root = outputDirectory(t), first = 'a'.repeat(20), second = 'b'.repeat(20)
  const files = createWorldbookSkillFiles(root)
  await files.sync(first, new Map([['SKILL.md', 'old']]))
  await files.assign(first, '江湖')
  await files.sync(first, new Map([['SKILL.md', 'new']]))
  assert.equal(path.basename(files.directory(first)), '江湖')
  await assert.rejects(fs.access(path.join(root, first)))
  await files.assign(second, '江湖')
  await files.sync(second, new Map([['SKILL.md', 'other game']]))
  assert.equal(path.basename(files.directory(second)), '江湖--2')
  const restarted = createWorldbookSkillFiles(root)
  await restarted.assign(second, '江湖')
  assert.equal(restarted.directory(second), files.directory(second))
  await restarted.remove(first)
  assert.equal(await fs.readFile(path.join(files.directory(second), 'SKILL.md'), 'utf8'), 'other game')
  await restarted.assign(first, '江湖')
  assert.equal(path.basename(restarted.directory(first)), '江湖')
})

test('large source category lists every reference directly in SKILL.md', async t => {
  const f = fixture(t), state = f.states.get('one'), seed = state.worldBook.view.entries[0]
  state.worldBook.view.entries = Array.from({length:13}, (_,i) => ({...seed,ref:`ref-${i}`,sourceUid:i,title:`功法·招式${i}`,content:`完整原文${i}`}))
  const view = await f.provider.inspect(f.lookup('one'))
  assert.equal(view.clusters.length, 1)
  const cluster = view.clusters[0]
  assert.equal(cluster.title, '功法')
  assert.doesNotMatch(cluster.guide, /references\/资料目录.md/)
  assert.doesNotMatch(cluster.guide, /完整原文/)
  const listed = (await f.provider.list(f.lookup('one'))).candidates
  assert.ok(listed.every(item => Array.from(item.description).length <= 100))
  assert.ok(listed.every(item => !item.description.includes('完整原文')))
  assert.ok(cluster.guide.length < 1000)
  assert.equal(await f.provider.readResource(path.join(cluster.directory, 'references/资料目录.md'), f.lookup('one')), undefined)
  for (const e of cluster.entries) {
    assert.ok(cluster.guide.includes(`(references/${path.basename(e.path)})`))
    assert.equal(await fs.readFile(e.path,'utf8'), state.worldBook.view.entries.find(raw => raw.ref===e.ref).content)
  }
})

test('reference filenames omit IDs and control tags and resolve actual name collisions deterministically', async () => {
  const { referenceFile } = await import('../tavern-plugin/lib/domain/worldbook-skill-files.js')
  const entries = [{ref:'a',sourceUid:129,title:'[mvu_plot]大事·大江山鬼战'}, {ref:'b',title:'同名'}, {ref:'c',title:'同名'}, {ref:'d',title:'同名--2'}, {ref:'e',title:'资料目录'}]
  assert.equal(referenceFile(entries[0],entries),'references/大事·大江山鬼战.md')
  const names=entries.map(e=>referenceFile(e,entries))
  assert.equal(new Set(names).size,entries.length)
  assert.ok(!names.includes('references/资料目录.md'))
  assert.deepEqual(entries.map(e=>referenceFile(e,[...entries].reverse())),names)
})

test('physical Skill catalog excludes constants, initialization, code, macros and MVU rules', async t => {
  const f = fixture(t), state = f.states.get('one')
  const original = state.worldBook.view.entries[0]
  state.worldBook.view.entries.push(...[
    { constant: true }, { content: '<%= value %>' }, { content: '{{getvar::value}}' },
    { title: '[InitVar]初始化', content: '{}' }, { title: '[mvu_update]规则' },
    { content: '<script>run()</script>' }
  ].map((overrides, index) => ({ ...original, ref: 'excluded-' + index, sourceUid: index + 100, ...overrides })))
  const inspected = await f.provider.inspect(f.lookup('one'))
  assert.deepEqual(inspected.clusters.flatMap(cluster => cluster.entries.map(entry => entry.ref)), [original.ref])
})
