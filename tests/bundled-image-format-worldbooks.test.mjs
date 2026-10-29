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
