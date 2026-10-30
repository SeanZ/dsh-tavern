import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFormatWorldbooks, normalizeFormatWorldbook, structuredWorldbookDefaults,
  FORMAT_WORLDBOOK_MODES, FORMAT_WORLDBOOK_GROUPS,
} from '../tavern-plugin/packages/dsh-tavern-image-bundled/lib/format-worldbooks.js'
import { selectPlannerContext } from '../tavern-plugin/packages/dsh-tavern-image-bundled/lib/planner-context.js'

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-format-worldbooks-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}
const main = {
  name: '我的生图规则', customMetadata: { keep: true }, entries: [
    { uid: 7, comment: '关闭', content: '不要启用这条', enabled: false, backends: ['tags'] },
    { uid: 8, comment: '常驻', content: '旧规则常驻', enabled: true, constant: true },
    { uid: 9, comment: '按需', content: '仅窗边', enabled: true, activation: 'keywords', keywords: ['窗'], andKeywords: ['雨'], backends: ['natural', 'structured'] },
  ],
}
const outfits = { name: '服装规则', entries: [{ comment: '服装', content: '只描述当前衣服', enabled: true }] }
async function seedLegacy(root, a = main, b = outfits) {
  const text = JSON.stringify(a, null, 3) + '\n\n', outfitText = JSON.stringify(b)
  await fs.writeFile(join(root, 'worldbook.json'), text)
  await fs.writeFile(join(root, 'worldbook-outfits.json'), outfitText)
  return { text, outfitText }
}
const pathFor = (root, mode, key = 'main') => join(root, 'format-worldbooks', mode, key === 'main' ? 'worldbook.json' : 'worldbook-outfits.json')

test('first migration independently copies both old books into three formats and backs up exact original bytes', async t => {
  const root = await fixture(t), { text, outfitText } = await seedLegacy(root)
  const store = createFormatWorldbooks({ root })
  const result = await store.ensure()
  assert.equal(result.created.length, 8)
  assert.equal(await fs.readFile(join(root, 'worldbook.json'), 'utf8'), text)
  assert.equal(await fs.readFile(join(root, 'worldbook-outfits.json'), 'utf8'), outfitText)
  assert.equal(await fs.readFile(join(result.backupFolder, 'worldbook.json'), 'utf8'), text)
  assert.equal(await fs.readFile(join(result.backupFolder, 'worldbook-outfits.json'), 'utf8'), outfitText)
  for (const mode of ['tags', 'natural', 'mixed']) {
    const book = await store.readBook(mode, 'main')
    assert.equal(book.name, main.name)
    assert.deepEqual(book.customMetadata, { keep: true })
    assert.equal(book.entries[0].enabled, false)
    assert.equal(book.entries[0].uid, 7)
    assert.deepEqual(book.entries[2].backends, ['natural', 'structured'])
    assert.deepEqual(book.entries[2].andKeywords, ['雨'])
    assert.equal((await store.readBook(mode, 'outfits')).name, outfits.name)
  }
  const structured = await store.readFormat('structured')
  assert.match(structured.entries.map(e => e.content).join('\n'), /结构化中文自然语言/)
  assert.doesNotMatch(structured.entries.map(e => e.content).join('\n'), /旧规则常驻|画面任务/)
  assert.deepEqual(structured.books.map(book => book.key), ['main', 'outfits'])
})

test('readFormat provides stable global indexes plus original group indexes and keeps enabled activation', async t => {
  const root = await fixture(t)
  await seedLegacy(root)
  const store = createFormatWorldbooks({ root })
  const loaded = await store.readFormat('natural')
  assert.deepEqual(loaded.entries.map(e => [e.index, e.book, e.bookIndex]), [[0, 'main', 0], [1, 'main', 1], [2, 'main', 2], [3, 'outfits', 0]])
  const context = selectPlannerContext({ entries: loaded.entries, promptMode: 'natural', text: '雨中窗边' })
  assert.doesNotMatch(context.staticRules, /不要启用这条/)
  assert.match(context.staticRules, /旧规则常驻|只描述当前衣服/)
  assert.match(context.dynamicRules, /仅窗边/)
  const listed = await store.listBooks('natural')
  assert.equal(listed[0].count, 3)
  assert.equal(listed[0].enabled, 2)
  assert.equal(listed[0].file, 'format-worldbooks/natural/worldbook.json')
  assert.deepEqual(listed[1].entries.map(e => e.index), [0])
})

test('each format/group is independently editable; reads are fresh and empty edits survive restart', async t => {
  const root = await fixture(t)
  await seedLegacy(root)
  const store = createFormatWorldbooks({ root })
  await store.ensure()
  await store.writeBook('natural', 'main', { name: '自然语言新规则', entries: [] })
  await store.writeBook('structured', 'outfits', { name: '自定义服装规则', entries: [{ content: '【我的章节】可自行改名', enabled: false }] })
  assert.equal((await store.readBook('tags', 'main')).name, main.name)
  assert.equal((await store.readBook('mixed', 'main')).name, main.name)
  assert.equal((await store.readBook('natural', 'outfits')).name, outfits.name)
  const restart = createFormatWorldbooks({ root })
  assert.equal((await restart.ensure()).created.length, 0)
  assert.deepEqual((await restart.readBook('natural', 'main')).entries, [])
  assert.equal((await restart.readBook('structured', 'outfits')).entries[0].enabled, false)
  // An external edit also becomes visible: there is no stale merged-book cache.
  await fs.writeFile(pathFor(root, 'tags'), JSON.stringify({ name: '外部编辑', entries: [] }))
  assert.equal((await store.readBook('tags', 'main')).name, '外部编辑')
  const backups = await fs.readdir(join(root, 'backups', 'format-worldbooks-edits'))
  assert.equal(backups.length, 2)
})

test('partial migration restart uses pinned snapshot even if legacy sources changed, and never overwrites an existing edit', async t => {
  const root = await fixture(t)
  await seedLegacy(root)
  let fail = true
  const injected = { ...fs, link: async (from, to) => {
    if (fail && to === pathFor(root, 'natural')) { fail = false; throw Object.assign(new Error('simulated interruption'), { code: 'EIO' }) }
    return fs.link(from, to)
  } }
  await assert.rejects(createFormatWorldbooks({ root, io: injected }).ensure(), /simulated interruption/)
  await fs.writeFile(pathFor(root, 'tags'), JSON.stringify({ name: '已编辑的标签规则', entries: [] }))
  await fs.writeFile(join(root, 'worldbook.json'), JSON.stringify({ name: '迁移后改动的旧数据', entries: [] }))
  const restarted = createFormatWorldbooks({ root })
  await restarted.ensure()
  assert.equal((await restarted.readBook('tags', 'main')).name, '已编辑的标签规则')
  assert.equal((await restarted.readBook('natural', 'main')).name, main.name)
  assert.equal((await restarted.readBook('mixed', 'main')).name, main.name)
  assert.equal(JSON.parse(await fs.readFile(join(root, 'worldbook.json'), 'utf8')).name, '迁移后改动的旧数据')
})

test('same-instance retry after transient migration failure is possible and concurrent initializers do not overwrite winners', async t => {
  const root = await fixture(t)
  await seedLegacy(root)
  let fail = true
  const store = createFormatWorldbooks({ root, io: { ...fs, link: async (from, to) => {
    if (fail && to.includes('format-worldbooks-v1')) { fail = false; throw new Error('backup unavailable') }
    return fs.link(from, to)
  } } })
  await assert.rejects(store.ensure(), /backup unavailable/)
  const [a, b] = await Promise.all([store.ensure(), createFormatWorldbooks({ root }).ensure()])
  assert.equal(a.created.length + b.created.length, 8)
  assert.deepEqual((await store.readBook('natural', 'main')).entries.map(e => e.enabled), [false, true, true])
})

test('missing legacy files use seed books without creating or modifying old data paths', async t => {
  const root = await fixture(t)
  await fs.writeFile(join(root, '世界书-通用生图规则.json'), JSON.stringify({ 种子书: { entries: [{ content: '种子正文', disable: true }] } }))
  const store = createFormatWorldbooks({ root })
  await store.ensure()
  await assert.rejects(fs.readFile(join(root, 'worldbook.json')), { code: 'ENOENT' })
  const imported = await store.readBook('tags', 'main')
  assert.equal(imported.name, '种子书')
  assert.equal(imported.entries[0].enabled, false)
  assert.equal(imported.entries[0].content, '种子正文')
  imported.entries[0].enabled = true
  await store.writeBook('tags', 'main', imported)
  assert.equal((await store.readBook('tags', 'main')).entries[0].enabled, true, 'legacy disable alias must not defeat the editable enabled switch')
  assert.deepEqual((await store.readBook('tags', 'outfits')).entries, [])
})

test('malformed old or independently edited JSON is reported, not silently replaced by defaults', async t => {
  const root = await fixture(t)
  await fs.writeFile(join(root, 'worldbook.json'), '{broken')
  const store = createFormatWorldbooks({ root })
  await assert.rejects(store.ensure(), /JSON 无效/)
  assert.equal(await fs.readFile(join(root, 'worldbook.json'), 'utf8'), '{broken')
  await assert.rejects(fs.readFile(join(root, 'format-worldbooks', 'migration-v1.json')), { code: 'ENOENT' })
  await fs.writeFile(join(root, 'worldbook.json'), JSON.stringify(main))
  await store.ensure()
  await fs.writeFile(pathFor(root, 'structured'), '{custom broken')
  await assert.rejects(createFormatWorldbooks({ root }).readBook('structured', 'main'), /JSON 无效/)
  assert.equal(await fs.readFile(pathFor(root, 'structured'), 'utf8'), '{custom broken')
})

test('save snapshots invocation data, serializes same-file writes, and preserves the original on atomic replace failure', async t => {
  const root = await fixture(t)
  await seedLegacy(root)
  let fail = false
  const store = createFormatWorldbooks({ root, io: { ...fs, rename: async (from, to) => {
    if (fail) throw new Error('replace denied')
    return fs.rename(from, to)
  } } })
  await store.ensure()
  const draft = { name: 'first', entries: [{ content: 'first' }] }
  const first = store.writeBook('tags', 'main', draft)
  draft.name = 'caller mutation'
  const second = store.writeBook('tags', 'main', { name: 'second', entries: [] })
  assert.equal((await first).name, 'first')
  await second
  assert.equal((await store.readBook('tags', 'main')).name, 'second')
  fail = true
  await assert.rejects(store.writeBook('tags', 'main', { name: 'must not replace', entries: [] }), /replace denied/)
  assert.equal((await store.readBook('tags', 'main')).name, 'second')
  assert.equal((await fs.readdir(join(root, 'format-worldbooks', 'tags'))).some(name => name.includes('.tmp-')), false)
})

test('book normalizer preserves metadata and accepts supported legacy import shapes', () => {
  const inputs = [
    { entries: { '4': { uid: 4, content: 'hello', disable: true, key: ['hello'], constant: false } } },
    { 旧书: { entries: [{ uid: 4, content: 'hello', disable: true, key: ['hello'] }] } },
    [{ uid: 4, content: 'hello', disable: true, key: ['hello'] }],
  ]
  for (const input of inputs) {
    const normalized = normalizeFormatWorldbook(input)
    assert.equal(normalized.entries[0].uid, 4)
    assert.equal(normalized.entries[0].enabled, false)
    assert.equal(normalized.entries[0].activation, 'keywords')
    assert.deepEqual(normalized.entries[0].keywords, ['hello'])
  }
  assert.equal(normalizeFormatWorldbook('第一段\n\n第二段').entries.length, 2)
  assert.throws(() => normalizeFormatWorldbook({ unrecognized: 1 }), /entries/)
  assert.throws(() => normalizeFormatWorldbook({ entries: [null] }), /条目不是对象/)
})

test('validated mode/group cannot escape storage; structured seeds are fresh independent objects', async t => {
  const root = await fixture(t)
  const store = createFormatWorldbooks({ root })
  for (const mode of ['auto', '../tags', 'STRUCTURED', '']) await assert.rejects(store.readBook(mode, 'main'), /世界书格式/)
  await assert.rejects(store.writeBook('tags', '../main', { entries: [] }), /世界书分组/)
  const first = structuredWorldbookDefaults(), second = structuredWorldbookDefaults()
  first.main.entries[0].content = 'changed'
  assert.notEqual(first.main.entries[0].content, second.main.entries[0].content)
  assert.deepEqual(FORMAT_WORLDBOOK_GROUPS, ['main', 'outfits'])
  assert.deepEqual(FORMAT_WORLDBOOK_MODES, ['tags', 'natural', 'mixed', 'structured'])
})

async function installedV1(t, change = () => {}) {
  const root = await fixture(t)
  await createFormatWorldbooks({ root }).ensure()
  const books = structuredWorldbookDefaults(1)
  change(books)
  for (const key of FORMAT_WORLDBOOK_GROUPS) await fs.writeFile(pathFor(root, 'structured', key), JSON.stringify(books[key]))
  return { root, books }
}

test('v2 fresh seeds contain semantic rules, short Chinese examples and version fingerprints', async t => {
  const store = createFormatWorldbooks({ root: await fixture(t) })
  const book = await store.readBook('structured', 'main')
  assert.equal(book.defaultSeed.version, 2)
  assert.equal(book.entries.length, 6)
  assert.equal(Object.keys(book.defaultSeed.fingerprints).length, 6)
  const text = book.entries.map(e => e.content).join('\n')
  for (const pattern of [/时间点/, /接触点/, /裁切/, /光源/, /林月/, /江铭/, /不能按输出前一张/]) assert.match(text, pattern)
  assert.doesNotMatch(text, /<image>|<subjects>|<decision>|image\/regex\/prompts/)
  const status = await store.getUpgradeStatus('main')
  assert.equal(status.available, false)
  assert.ok(status.entries.every(e => e.state === 'current'))
})

test('untouched v1 groups upgrade with exact-byte backups and restart is idempotent', async t => {
  const { root } = await installedV1(t)
  const before = await fs.readFile(pathFor(root, 'structured'), 'utf8')
  const tags = await fs.readFile(pathFor(root, 'tags'), 'utf8')
  const store = createFormatWorldbooks({ root })
  const result = await store.ensure()
  const upgraded = result.upgrades.find(item => item.key === 'main')
  assert.equal(await fs.readFile(upgraded.backupFile, 'utf8'), before)
  assert.deepEqual(await store.readBook('structured', 'main'), structuredWorldbookDefaults().main)
  assert.equal(await fs.readFile(pathFor(root, 'tags'), 'utf8'), tags)
  const backups = await fs.readdir(join(root, 'backups', 'format-worldbooks-upgrades'))
  const restart = createFormatWorldbooks({ root })
  await restart.ensure()
  assert.deepEqual(await fs.readdir(join(root, 'backups', 'format-worldbooks-upgrades')), backups)
  assert.equal((await restart.getUpgradeStatus('main')).available, false)
})

test('edited, disabled, deleted, reordered and extended v1 groups never receive new defaults automatically', async t => {
  for (const scenario of ['edited', 'disabled', 'deleted', 'reordered', 'extended', 'title']) await t.test(scenario, async t => {
    const { root, books } = await installedV1(t, books => {
      const b = books.main
      if (scenario === 'edited') b.entries[0].content = '用户正文不可覆盖'
      if (scenario === 'disabled') b.entries[0].enabled = false
      if (scenario === 'deleted') b.entries.splice(0, 1)
      if (scenario === 'reordered') b.entries.reverse()
      if (scenario === 'extended') b.entries.push({ id: 'mine', content: '用户规则' })
      if (scenario === 'title') b.name = '我的标题'
    })
    const store = createFormatWorldbooks({ root })
    const result = await store.readBook('structured', 'main')
    assert.deepEqual(result.entries.map(e => e.id), books.main.entries.map(e => e.id))
    const first = result.entries.find(e => e.id === 'structured-prose')
    if (scenario === 'edited') assert.equal(first.content, '用户正文不可覆盖')
    if (scenario === 'disabled') { assert.equal(first.enabled, false); assert.equal(first.content, books.main.entries[0].content) }
    const other = result.entries.find(e => e.id === 'structured-story')
    assert.equal(other.content, structuredWorldbookDefaults().main.entries[1].content, 'unchanged old entries can update independently')
    const restart = createFormatWorldbooks({ root })
    assert.deepEqual((await restart.readBook('structured', 'main')).entries, result.entries)
  })
})

test('empty and wholly custom groups stay byte-for-byte unchanged across initialization and restart', async t => {
  for (const entries of [[], [{ id: 'mine', content: '完全自定义' }]]) {
    const { root } = await installedV1(t, books => { books.main = { name: '自定义', entries } })
    const before = await fs.readFile(pathFor(root, 'structured'), 'utf8')
    await createFormatWorldbooks({ root }).ensure()
    await createFormatWorldbooks({ root }).ensure()
    assert.equal(await fs.readFile(pathFor(root, 'structured'), 'utf8'), before)
  }
})

test('explicit upgrade restores only selected entries, preserves disabled state, backs up and rejects stale previews', async t => {
  const { root } = await installedV1(t, books => {
    books.main.entries[0].content = '用户改过'
    books.main.entries[1].enabled = false
  })
  const store = createFormatWorldbooks({ root })
  const status = await store.getUpgradeStatus('main')
  assert.equal(status.entries[0].state, 'customized')
  assert.equal(status.entries[1].state, 'disabled')
  assert.equal(status.entries[2].state, 'missing')
  assert.equal(status.entries[2].current, null)
  const before = await fs.readFile(pathFor(root, 'structured'), 'utf8')
  const updated = await store.applyDefaultUpgrade('main', { expectedFingerprint: status.fingerprint, entryIds: ['structured-prose', 'structured-story', 'structured-people'] })
  assert.equal(await fs.readFile(updated.backupFile, 'utf8'), before)
  const book = await store.readBook('structured', 'main')
  assert.equal(book.entries.length, 3)
  assert.equal(book.entries[1].enabled, false)
  assert.equal(book.entries[0].content, status.entries[0].proposed.content)
  assert.equal((await store.getUpgradeStatus('main')).fingerprint, updated.fingerprint)
  await assert.rejects(store.applyDefaultUpgrade('main', { expectedFingerprint: status.fingerprint, entryIds: ['structured-space'] }), { code: 'WORLDBOOK_UPGRADE_STALE' })
  assert.deepEqual((await createFormatWorldbooks({ root }).readBook('structured', 'main')).entries, book.entries)
})

test('explicit upgrades validate selections and never replace originals when backup fails', async t => {
  const { root } = await installedV1(t, books => { books.main.entries = [] })
  let fail = false
  const store = createFormatWorldbooks({ root, io: { ...fs, link: async (from, to) => {
    if (fail && to.includes('format-worldbooks-upgrades')) throw new Error('backup denied')
    return fs.link(from, to)
  } } })
  const status = await store.getUpgradeStatus('main')
  const before = await fs.readFile(pathFor(root, 'structured'), 'utf8')
  await assert.rejects(store.applyDefaultUpgrade('../main', {}), /世界书分组/)
  await assert.rejects(store.applyDefaultUpgrade('main', { expectedFingerprint: status.fingerprint, entryIds: ['unknown'] }), /有效/)
  fail = true
  await assert.rejects(store.applyDefaultUpgrade('main', { expectedFingerprint: status.fingerprint, entryIds: ['structured-prose'] }), /backup denied/)
  assert.equal(await fs.readFile(pathFor(root, 'structured'), 'utf8'), before)
})

test('duplicate default IDs are ambiguous and never overwritten automatically or explicitly', async t => {
  const { root } = await installedV1(t, books => { books.main.entries.push({ ...books.main.entries[0], content: 'another' }) })
  const store = createFormatWorldbooks({ root })
  const status = await store.getUpgradeStatus('main')
  assert.equal(status.entries[0].state, 'ambiguous')
  await assert.rejects(store.applyDefaultUpgrade('main', { expectedFingerprint: status.fingerprint, entryIds: ['structured-prose'] }), /标识重复/)
  assert.equal((await store.readBook('structured', 'main')).entries.filter(e => e.id === 'structured-prose').length, 2)
})

test('upgrade previews detect concurrent edits and compare-and-write after backup', async t => {
  const { root } = await installedV1(t, books => { books.main.entries = [] })
  let editDuringBackup = false
  const store = createFormatWorldbooks({ root, io: { ...fs, link: async (from, to) => {
    const result = await fs.link(from, to)
    if (editDuringBackup && to.includes('format-worldbooks-upgrades')) {
      editDuringBackup = false
      await fs.writeFile(pathFor(root, 'structured'), JSON.stringify({ name: '外部并发修改', entries: [] }))
    }
    return result
  } } })
  const status = await store.getUpgradeStatus('main')
  editDuringBackup = true
  await assert.rejects(store.applyDefaultUpgrade('main', { expectedFingerprint: status.fingerprint, entryIds: ['structured-story'] }), { code: 'WORLDBOOK_UPGRADE_STALE' })
  assert.equal((await store.readBook('structured', 'main')).name, '外部并发修改')
  const fresh = await store.getUpgradeStatus('main')
  const second = createFormatWorldbooks({ root })
  await second.ensure()
  const results = await Promise.allSettled([
    store.applyDefaultUpgrade('main', { expectedFingerprint: fresh.fingerprint, entryIds: ['structured-story'] }),
    second.applyDefaultUpgrade('main', { expectedFingerprint: fresh.fingerprint, entryIds: ['structured-visible'] }),
  ])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'WORLDBOOK_UPGRADE_STALE')
})
