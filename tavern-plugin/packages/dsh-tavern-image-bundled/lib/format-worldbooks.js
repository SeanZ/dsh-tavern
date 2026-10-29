import * as nodeFs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { normalizeEntryActivation } from './planner-context.js'
import { PROMPT_FORMATS, STRUCTURED_PROMPT_GUIDANCE } from './prompt-presets.js'

export const FORMAT_WORLDBOOK_MODES = PROMPT_FORMATS
export const FORMAT_WORLDBOOK_GROUPS = Object.freeze(['main', 'outfits'])
const BOOKS = Object.freeze({
  main: { file: 'worldbook.json', seed: '世界书-通用生图规则.json', label: '生图规则' },
  outfits: { file: 'worldbook-outfits.json', seed: '世界书-角色与服装库.json', label: '角色与服装库' },
})
const MIGRATION_VERSION = 1
const json = value => JSON.stringify(value, null, 2) + '\n'
const clone = value => JSON.parse(JSON.stringify(value))

function assertMode(mode) {
  if (!FORMAT_WORLDBOOK_MODES.includes(mode)) throw new Error('世界书格式必须是 tags、natural、mixed 或 structured；auto 请先解析为实际格式')
  return mode
}
function assertGroup(key) {
  if (!FORMAT_WORLDBOOK_GROUPS.includes(key)) throw new Error('世界书分组必须是 main 或 outfits')
  return key
}

/** Preserve authored entry metadata and activation, while accepting old import shapes. */
export function normalizeFormatWorldbook(raw, { name = '生图世界书' } = {}) {
  let list, title = name, extra = {}
  if (typeof raw === 'string') {
    list = raw.split(/\n{2,}/).map(text => text.trim()).filter(Boolean).map(content => ({ content }))
  } else if (Array.isArray(raw)) {
    list = raw
  } else if (raw && typeof raw === 'object') {
    let source = raw
    if (!Object.hasOwn(raw, 'entries')) {
      const nested = Object.entries(raw).find(([, value]) => value && typeof value === 'object' && Object.hasOwn(value, 'entries'))
      if (!nested) throw new Error('世界书缺少 entries')
      title = nested[0]
      source = nested[1]
    }
    title = String(source.name ?? raw.name ?? title)
    extra = { ...source }
    if (Array.isArray(source.entries)) list = source.entries
    else if (source.entries && typeof source.entries === 'object') list = Object.values(source.entries)
    else throw new Error('世界书 entries 必须是数组或条目对象')
  } else throw new Error('世界书内容格式无效')
  const entries = list.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('世界书第 ' + (index + 1) + ' 个条目不是对象')
    // `enabled` is the editable switch after import. Retaining an old
    // disable:true alias would permanently defeat a later enabled:true edit.
    const { disable, ...metadata } = entry
    return {
      ...metadata,
      comment: String(entry.comment ?? entry.name ?? ('条目 ' + (index + 1))),
      content: String(entry.content ?? ''),
      enabled: entry.enabled !== false && disable !== true,
      ...normalizeEntryActivation(entry),
    }
  })
  return { ...extra, name: title, entries }
}

/** A fresh pair on every call, so editing one format/group never mutates a seed. */
export function structuredWorldbookDefaults() {
  const entry = (id, comment, content) => ({ id, comment, content, enabled: true, activation: 'always', keywords: [], andKeywords: [], backends: ['structured'] })
  return {
    main: { name: '结构化中文 · 生图规则', entries: [
      entry('structured-prose', '中文分节（默认结构可修改）', STRUCTURED_PROMPT_GUIDANCE),
      entry('structured-story', '画面事实与叙事瞬间', [
        '从本轮正文选择明确发生的可视瞬间，按各张画面对应的时点描述人物、衣着、动作和环境。',
        '有多张图时，各自突出不同的瞬间、景别或动作，不编造正文没有发生的事件。',
        '画风、构图、灯光和材质要求不能覆盖剧情事实；不要为了套预设添加不在场人物或道具。',
        '本书可调整提示词内部的分节，但外层 image/regex/prompts XML、决定与逐张闭合输出仍遵循插件协议。',
      ].join('\n')),
    ] },
    outfits: { name: '结构化中文 · 角色与服装库', entries: [
      entry('structured-identity', '人物与参考图一致性', [
        '只使用可用角色清单和本轮正文，已知人物保持身份一致；未知人物照正文描述，不编造人物库 ID。',
        '若清单标有身份参考图，该图用于身份外观而不是照搬服装、姿势和背景。若没有参考图，用库内文字和正文写清可见外貌。',
        '规划只收到文字清单，不能声称已经看过参考图；实际图片及其编号由插件按本张人物与服装对应关系确定。',
        '一致性补充与本轮明确的外貌状态变化应清楚表达，不把不同人物的特征混写，也不全局删除他们共有的特征。',
      ].join('\n')),
      entry('structured-clothes', '当刻服装与状态', [
        '按每张画面所处时点确定穿着。正文明确换装、湿衣、破损等变化时，以正文当下状态为准。',
        '引用库中服装时保持服装名准确，并按协议使用该套服装的标识；不要把标识或“常穿”备注误当成服装名。',
        '服装参考图只约束服饰设计，不继承图中人物、动作或背景；缺少参考图时用中文自然语言说明衣物颜色、款式和可见状态。',
        '只描述当前画面真正可见的内容；世界书可以改写本组表达方式，不必输出空白分节。',
      ].join('\n')),
    ] },
  }
}

/**
 * Independent worldbooks, scoped to an explicit resolved prompt format.
 *
 * IO defaults to node:fs/promises; tests/hosts may supply an fs-compatible object
 * with readFile, writeFile, mkdir, link, rename and unlink. All methods are async.
 *
 * Paths: format-worldbooks/<format>/{worldbook,worldbook-outfits}.json.
 * An immutable migration snapshot pins both old sources before any copy is made.
 * Originals are never modified; exact source bytes are backed up. Restarting a
 * partial migration creates missing books from that snapshot and never replaces
 * existing books, including empty books or user edits made during an interruption.
 */
export function createFormatWorldbooks({ root, io = nodeFs } = {}) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('需要世界书根目录 root')
  const base = resolve(root)
  const folder = join(base, 'format-worldbooks')
  const migrationFile = join(folder, 'migration-v1.json')
  const backupFolder = join(base, 'backups', 'format-worldbooks-v1')
  const writes = new Map()
  let ready = null

  const fileFor = (mode, key) => join(folder, assertMode(mode), BOOKS[assertGroup(key)].file)
  async function readText(file) {
    try { return await io.readFile(file, 'utf8') }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  function parse(text, file) {
    try { return JSON.parse(text) }
    catch (error) { throw new Error('世界书 JSON 无效：' + file, { cause: error }) }
  }
  async function removeTemp(file) {
    try { await io.unlink(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  // Both publication operations expose only complete files. A hard link provides
  // atomic create-if-absent (rename alone would overwrite another initializer's
  // winner). Temp files always live beside a validated internal target path.
  async function publish(file, text, replace = false) {
    await io.mkdir(dirname(file), { recursive: true })
    const temp = file + '.tmp-' + randomUUID()
    await io.writeFile(temp, text, { encoding: 'utf8', flag: 'wx' })
    try {
      if (replace) await io.rename(temp, file)
      else {
        try { await io.link(temp, file) }
        catch (error) { if (error.code === 'EEXIST') return false; throw error }
      }
      return true
    } finally { await removeTemp(temp) }
  }
  async function legacySource(key) {
    const book = BOOKS[key]
    let file = book.file, text = await readText(join(base, file))
    if (text === null) { file = book.seed; text = await readText(join(base, file)) }
    const document = text === null ? { name: book.label, entries: [] }
      : normalizeFormatWorldbook(parse(text, file), { name: book.label })
    return { file: text === null ? null : file, text, document }
  }
  async function initialize() {
    let saved = await readText(migrationFile)
    if (saved === null) {
      const snapshot = { version: MIGRATION_VERSION, sources: {} }
      // Parse both before publishing anything: malformed old data is an explicit
      // error, never an invitation to overwrite it with empty/default rules.
      for (const key of FORMAT_WORLDBOOK_GROUPS) snapshot.sources[key] = await legacySource(key)
      await publish(migrationFile, json(snapshot))
      saved = await readText(migrationFile)
    }
    const snapshot = parse(saved, migrationFile)
    if (snapshot?.version !== MIGRATION_VERSION) throw new Error('世界书迁移快照版本无效')
    for (const key of FORMAT_WORLDBOOK_GROUPS) {
      const source = snapshot.sources?.[key]
      if (!source || !source.document || (source.text !== null && typeof source.text !== 'string')) throw new Error('世界书迁移快照缺少 ' + key)
      normalizeFormatWorldbook(source.document)
      if (source.file !== null) {
        // Snapshot data cannot escape the reserved backup directory.
        if (![BOOKS[key].file, BOOKS[key].seed].includes(source.file) || typeof source.text !== 'string') throw new Error('世界书迁移快照来源无效')
        const target = join(backupFolder, source.file)
        await publish(target, source.text)
        if (await readText(target) !== source.text) throw new Error('世界书迁移备份与快照不一致：' + source.file)
      }
    }
    const defaults = structuredWorldbookDefaults()
    const created = []
    for (const mode of FORMAT_WORLDBOOK_MODES) {
      for (const key of FORMAT_WORLDBOOK_GROUPS) {
        const document = mode === 'structured' ? defaults[key] : snapshot.sources[key].document
        if (await publish(fileFor(mode, key), json(document))) created.push({ mode, key })
      }
    }
    return { version: MIGRATION_VERSION, created, migrationFile, backupFolder }
  }
  function ensure() {
    if (!ready) ready = initialize().catch(error => { ready = null; throw error })
    return ready
  }
  async function readBook(mode, key) {
    const file = fileFor(mode, key)
    await ensure()
    const text = await readText(file)
    if (text === null) throw new Error('独立世界书文件已不存在：' + mode + '/' + key)
    return normalizeFormatWorldbook(parse(text, file), { name: BOOKS[key].label })
  }
  async function writeBook(mode, key, value) {
    const file = fileFor(mode, key)
    // Capture data at invocation time: subsequent caller edits must not mutate a
    // queued write. No cross-format or main/outfits merged view can leak into it.
    const document = clone(normalizeFormatWorldbook(value, { name: BOOKS[key].label }))
    await ensure()
    const previous = writes.get(file) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(async () => {
      const old = await readText(file)
      if (old !== null) {
        const backup = join(base, 'backups', 'format-worldbooks-edits', mode + '-' + key + '-' + Date.now() + '-' + randomUUID() + '.json')
        await publish(backup, old)
      }
      await publish(file, json(document), true)
      return clone(document)
    })
    writes.set(file, operation)
    try { return await operation }
    finally { if (writes.get(file) === operation) writes.delete(file) }
  }
  async function listBooks(mode) {
    assertMode(mode)
    return Promise.all(FORMAT_WORLDBOOK_GROUPS.map(async key => {
      const book = await readBook(mode, key)
      const entries = book.entries.map((entry, index) => ({ ...entry, index, length: entry.content.length }))
      return { format: mode, key, file: 'format-worldbooks/' + mode + '/' + BOOKS[key].file, label: BOOKS[key].label,
        name: book.name, count: entries.length, enabled: entries.filter(entry => entry.enabled !== false).length, entries }
    }))
  }
  async function readFormat(mode) {
    const books = await listBooks(mode)
    const entries = []
    for (const book of books) for (const entry of book.entries) entries.push({ ...entry, book: book.key, bookIndex: entry.index, index: entries.length })
    return { format: mode, name: books[0].name, entries, books }
  }
  return { ensure, readBook, writeBook, readFormat, listBooks }
}
