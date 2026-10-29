import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTransferManifest, packTransferBundle, readTransferBundle } from '../tavern-plugin/lib/domain/transfer-bundle.js'
import { createTransferCatalog } from '../tavern-plugin/lib/domain/transfer-catalog.js'
import { createTransferImport } from '../tavern-plugin/lib/domain/transfer-import.js'

const CARD = JSON.stringify({ name: '作家', description: '写东西的人', extensions: {} })

function environment(options = {}) {
  const state = {
    cards: new Map(options.cards || [['cards/作家.json', CARD]]),
    worldbooks: new Map(options.worldbooks || [['worldbooks/世界观总纲.json', JSON.stringify({ name: '世界观总纲', entries: {} })]]),
    presets: new Map(options.presets || [['presets/默认.json', JSON.stringify({ prompts: [{ identifier: 'main', content: 'x' }] })]]),
    profiles: options.profiles || [{ id: 'default', name: '默认长期偏好', confirmed: { injectionText: '少写心理描写', summary: '偏短句' } }],
    regex: options.regex || [{ id: 'rx-1', name: '去掉思维链', findRegex: '/<thinking>[\\s\\S]*?<\\/thinking>/g', replaceString: '', enabled: true, placement: [2], trimStrings: [] }],
    settings: options.settings || { candidateDismissMode: 'after-send', headerItems: { display: 'icon-text', items: [] }, promptSets: { sets: [{ id: 'default', name: '默认方案', active: true }], activeSetId: 'default' } },
    imported: { cards: [], worldbooks: [], presets: [], profiles: [], prompts: [], settings: [], regex: 0 },
    backups: []
  }

  const fileResources = {
    async list(kind) {
      const map = { card: state.cards, worldbook: state.worldbooks, preset: state.presets }
      return [...(map[kind] || new Map()).keys()]
    },
    async readText(path) { return state.cards.get(path) ?? state.worldbooks.get(path) ?? state.presets.get(path) }
  }

  const worldBooks = {
    async catalog() {
      return { standalone: [...state.worldbooks.keys()].map(path => ({ kind: 'standalone', path, name: JSON.parse(state.worldbooks.get(path)).name, entryCount: 1 })), embedded: [], diagnostics: [] }
    },
    async export(locator) {
      const text = state.worldbooks.get(locator.path)
      if (text === undefined) throw new Error('世界书不存在')
      return { name: JSON.parse(text).name, document: JSON.parse(text) }
    },
    async characterBookForCard() { return null },
    async import(payload) {
      const name = payload.name
      state.worldbooks.set('worldbooks/' + name, payload.text)
      state.imported.worldbooks.push(name)
      return { kind: 'standalone', path: 'worldbooks/' + name, name: name.replace(/\.json$/, ''), entryCount: 1 }
    }
  }

  const presetLibrary = {
    async catalog() {
      return { presets: [...state.presets.keys()].map(path => ({ path, title: path.replace(/^presets\//, '').replace(/\.json$/, ''), valid: true, promptCount: 1 })), activePresetPath: 'presets/默认.json' }
    },
    async export(path) { return { name: path.split('/').pop(), text: state.presets.get(path) } }
  }

  const promptDocuments = {
    export(settings) {
      const active = settings.promptSets.sets.find(set => set.active)
      return { spec: 'dsh-tavern.system-prompts', version: 1, name: active.name, systemAppendEnabled: true, prompts: { story: '正文提示词' } }
    },
    import(document, fallback) {
      assert.equal(document.spec, 'dsh-tavern.system-prompts')
      return { action: 'add', name: fallback || document.name, promptOverrides: { story: document.prompts.story }, systemAppendEnabled: document.systemAppendEnabled !== false }
    }
  }

  const userPreferenceProfile = {
    async read(id) {
      const row = id ? state.profiles.find(item => item.id === id) : state.profiles[0]
      return { profileId: row.id, name: row.name, confirmed: row.confirmed, profiles: state.profiles.map(item => ({ id: item.id, name: item.name, hasConfirmed: true })) }
    },
    async manage(args) {
      const row = { id: 'profile-' + (state.profiles.length + 1), name: args.name, confirmed: { injectionText: args.content, summary: args.summary } }
      state.profiles.push(row)
      state.imported.profiles.push(args.name)
      return { profileId: row.id, name: row.name }
    }
  }

  const regexManager = {
    async read() { return { global: state.regex, sessionId: '', preset: [], card: [], overrides: {} } },
    async importGlobal({ text }) {
      const scripts = JSON.parse(text)
      state.imported.regex += scripts.length
      return { imported: scripts.length, global: [] }
    }
  }

  const readTavernSettings = () => state.settings
  const updateTavernSettings = async patch => {
    if (patch.promptSet) state.imported.prompts.push(patch.promptSet)
    state.imported.settings.push(patch)
    state.settings = Object.assign({}, state.settings, patch)
    return state.settings
  }

  const catalog = createTransferCatalog({
    fileResources,
    cardPreparation: {
      present: ({ card }) => {
        const value = JSON.parse(card.text)
        return { name: value.name, description: value.description || '', extensions: value.extensions || {} }
      }
    },
    readCardWorkspace: async path => ({ text: state.cards.get(path) }),
    worldBooks,
    presetLibrary,
    promptDocuments,
    userPreferenceProfile,
    regexManager,
    readTavernSettings,
    fileSize: async path => Buffer.byteLength(state.cards.get(path) ?? state.worldbooks.get(path) ?? state.presets.get(path) ?? ''),
    tavernVersion: '3.1.0',
    assets: options.assets,
    chats: options.chats,
    memory: options.memory
  })

  const importer = createTransferImport({
    fileResources,
    worldBooks,
    presetLibrary,
    promptDocuments,
    userPreferenceProfile,
    regexManager,
    readTavernSettings,
    updateTavernSettings,
    importCard: async payload => {
      state.imported.cards.push(payload.name)
      state.cards.set('cards/' + payload.name, payload.text)
      return { path: 'cards/' + payload.name }
    },
    importPreset: async payload => {
      state.imported.presets.push(payload.name)
      state.presets.set('presets/' + payload.name, payload.text)
      return { path: 'presets/' + payload.name }
    },
    assets: options.assets,
    chats: options.chats,
    memory: options.memory,
    backup: async (name, text) => { state.backups.push({ name, text }); return 'backups/transfer/20261027-160000/' + name },
    removeCreated: async (kind, path) => {
      const map = { cards: state.cards, worldbooks: state.worldbooks, presets: state.presets }[kind]
      if (map) map.delete(path)
    }
  })

  return { state, catalog, importer }
}

function bundleFrom(env, selection) {
  return env.catalog.collect(selection).then(collected => {
    const manifest = buildTransferManifest({ name: '另一个酒馆', parts: collected.parts })
    return readTransferBundle(packTransferBundle({ manifest, files: collected.files }))
  })
}

test('目录列出可导出板块与条目，未支持的板块也保留位置', async () => {
  const { catalog } = environment()
  const { parts } = await catalog.listParts()
  const byKind = Object.fromEntries(parts.map(part => [part.kind, part]))
  assert.equal(byKind.cards.items[0].title, '作家')
  assert.equal(byKind.worldbooks.items[0].title, '世界观总纲')
  assert.equal(byKind.presets.items[0].title, '默认')
  assert.equal(byKind.regex.items[0].title, '去掉思维链')
  assert.equal(byKind.chats.supported, true, '对话与存档已加入')
  assert.equal(byKind.plugins.supported, true, '插件已加入')
  assert.equal(byKind.scene.supported, false, '配图不单独成项')
  assert.equal(byKind.scene.items.length, 0)
  assert.match(byKind.scene.note, /含对话配图/)
})

test('收集所选条目：清单条目带哈希，文件内容与清单一致', async () => {
  const { catalog } = environment()
  const collected = await catalog.collect({ cards: ['cards/作家.json'], settings: ['current'] })
  assert.deepEqual(collected.parts.map(part => part.kind).sort(), ['cards', 'settings'])
  const cardPart = collected.parts.find(part => part.kind === 'cards')
  assert.equal(cardPart.items.length, 1)
  assert.match(cardPart.items[0].sha256, /^[0-9a-f]{64}$/)
  const text = collected.files.get(cardPart.items[0].entry).toString('utf8')
  assert.equal(JSON.parse(text).name, '作家')
  assert.equal(JSON.parse(collected.files.get('parts/settings/tavern-settings.json').toString('utf8')).candidateDismissMode, 'after-send')
})

test('预览指出同名冲突，应用时全部新建、不覆盖，并在写设置前备份', async () => {
  // Same names, different content: a copy is the right outcome, not a skip.
  const from = environment({
    cards: new Map([['cards/作家.json', JSON.stringify({ name: '作家', description: '另一台机器的版本', extensions: {} })]]),
    presets: new Map([['presets/默认.json', JSON.stringify({ prompts: [{ identifier: 'main', content: 'other' }] })]]),
    worldbooks: new Map([['worldbooks/世界观总纲.json', JSON.stringify({ name: '世界观总纲', entries: { 1: { uid: 1, key: ['a'], content: 'x' } } })]]),
    profiles: [{ id: 'default', name: '默认长期偏好', confirmed: { injectionText: '来自另一台机器', summary: '另一台' } }],
    regex: [{ id: 'rx-1', name: '去掉思维链', findRegex: '/<other>[\\s\\S]*?<\\/other>/g', replaceString: '', enabled: true, placement: [2], trimStrings: [] }]
  })
  const bundle = await bundleFrom(from, { cards: ['cards/作家.json'], worldbooks: ['worldbooks/世界观总纲.json'], presets: ['presets/默认.json'], prompts: ['current'], profile: ['default'], regex: ['rx-1'], settings: ['current'] })

  const to = environment()
  const preview = await to.importer.preview(bundle.manifest)
  const cards = preview.parts.find(part => part.kind === 'cards')
  assert.equal(cards.conflicts, 1, '本机已有同名人物卡')
  const worldbooks = preview.parts.find(part => part.kind === 'worldbooks')
  assert.equal(worldbooks.conflicts, 1)
  assert.equal(preview.parts.find(part => part.kind === 'settings').overwriteAllowed, true)

  const result = await to.importer.apply({ manifest: bundle.manifest, files: bundle.files, policies: {} })
  const rows = Object.fromEntries(result.results.map(row => [row.kind, row]))
  assert.equal(rows.cards.added, 1)
  assert.equal(rows.cards.failed.length, 0)
  assert.deepEqual(to.state.imported.cards, ['作家 (2).json'])
  assert.deepEqual(to.state.imported.worldbooks, ['世界观总纲 (2).json'])
  assert.deepEqual(to.state.imported.presets, ['默认 (2).json'])
  assert.equal(to.state.imported.prompts.length, 1)
  assert.match(to.state.imported.prompts[0].name, /默认方案 \(2\)/)
  assert.deepEqual(to.state.imported.profiles, ['默认长期偏好 (2)'])
  assert.equal(to.state.imported.regex, 1)
  assert.equal(to.state.imported.settings.filter(patch => !patch.promptSet).length, 1)
  assert.equal(to.state.backups.length, 1, '设置写入前留备份')
  assert.match(result.backupPath, /^backups\/transfer\//)
  assert.equal(to.state.profiles.at(-1).confirmed.injectionText, '来自另一台机器')
})

test('策略 skip 不写入该板块；导入包里的损坏条目单独记失败', async () => {
  const from = environment()
  const bundle = await bundleFrom(from, { cards: ['cards/作家.json'], presets: ['presets/默认.json'] })
  const to = environment({ cards: [], presets: [] })
  const result = await to.importer.apply({ manifest: bundle.manifest, files: new Map(), policies: { cards: 'skip' } })
  const rows = Object.fromEntries(result.results.map(row => [row.kind, row]))
  assert.equal(rows.cards.skipped, 1)
  assert.equal(rows.cards.added, 0)
  assert.deepEqual(rows.presets.failed.map(item => item.error), ['包内缺少该文件'])
  assert.equal(to.state.imported.presets.length, 0)
})

test('导入结果记录新建文件的路径，供撤销使用', async () => {
  const from = environment()
  const bundle = await bundleFrom(from, { cards: ['cards/作家.json'], presets: ['presets/默认.json'] })
  const to = environment({ cards: [], presets: [] })
  const result = await to.importer.apply({ manifest: bundle.manifest, files: bundle.files, policies: {} })
  const cards = result.results.find(row => row.kind === 'cards')
  const presets = result.results.find(row => row.kind === 'presets')
  assert.deepEqual(cards.created, [{ kind: 'cards', title: '作家', path: 'cards/作家.json' }])
  assert.deepEqual(presets.created, [{ kind: 'presets', title: '默认', path: 'presets/默认.json' }])
  assert.deepEqual(result.results.find(row => row.kind === 'chats'), undefined)
})

test('同一个包导入第二次：内容相同就跳过，不再堆副本', async () => {
  const from = environment()
  const bundle = await bundleFrom(from, { cards: ['cards/作家.json'], presets: ['presets/默认.json'] })

  const to = environment({ cards: [], presets: [] })
  const first = await to.importer.apply({ manifest: bundle.manifest, files: bundle.files, policies: {} })
  assert.equal(first.results.find(row => row.kind === 'cards').added, 1)
  assert.equal(to.state.cards.size, 1)

  const second = await to.importer.apply({ manifest: bundle.manifest, files: bundle.files, policies: {} })
  const cards = second.results.find(row => row.kind === 'cards')
  const presets = second.results.find(row => row.kind === 'presets')
  assert.equal(cards.added, 0, '第二次不再新增')
  assert.equal(cards.skipped, 1, '按跳过计数')
  assert.deepEqual(cards.duplicates, ['作家'])
  assert.equal(presets.added, 0)
  assert.equal(to.state.cards.size, 1, '本机仍只有一张卡')
  assert.equal(to.state.presets.size, 1, '预设也没有变多')
})

test('长期偏好与正则：内容相同就跳过，不再重复', async () => {
  const from = environment()
  const bundle = await bundleFrom(from, { profile: ['default'], regex: ['rx-1'] })
  const to = environment()
  const result = await to.importer.apply({ manifest: bundle.manifest, files: bundle.files, policies: {} })
  const profile = result.results.find(row => row.kind === 'profile')
  const regex = result.results.find(row => row.kind === 'regex')
  assert.equal(profile.added, 0)
  assert.equal(profile.skipped, 1)
  assert.equal(regex.added, 0)
  assert.equal(regex.skipped, 1)
  assert.equal(to.state.profiles.length, 1, '本机画像没有变多')
  assert.equal(to.state.imported.regex, 0)
})

test('素材包：预览认得这个板块，应用时按标题建新包、重名加序号', async () => {
  const calls = []
  const assets = {
    async list() { return [{ key: 'pack-a', title: '秋日教室', meta: '背景 1', bytes: 12 }] },
    async collect(ids) { return ids.map(id => ({ key: id, title: '秋日教室', fileName: id + '.zip', content: Buffer.from('pack-zip-bytes') })) },
    async importOne({ key, name, content }) { calls.push({ key, name, bytes: content.length }); return { id: 'pack-new', name } }
  }
  const to = environment({ assets })
  const bundle = await bundleFrom(to, { assets: ['pack-a'] })
  assert.deepEqual(bundle.manifest.parts.map(part => part.kind), ['assets'])

  const preview = await to.importer.preview(bundle.manifest, bundle.files)
  const part = preview.parts.find(row => row.kind === 'assets')
  assert.equal(part.importable, true)
  assert.equal(part.selectable, 1)
  assert.equal(part.conflicts, 1)
  assert.match(part.items[0].reason, /同名素材包已存在/)

  const result = await to.importer.apply({ manifest: bundle.manifest, files: bundle.files, selection: { assets: ['pack-a'] } })
  const row = result.results.find(item => item.kind === 'assets')
  assert.equal(row.added, 1)
  assert.deepEqual(row.failed, [])
  assert.deepEqual(calls, [{ key: 'pack-a', name: '秋日教室 (2)', bytes: 14 }])
})

test('游玩记忆随同包的存档并进新局；包里没带存档时明确说明无处可并', async () => {
  const merged = []
  const chats = {
    async list() { return [{ key: 'chat-1', title: '作家 · 第 3 章', meta: '3 轮', bytes: 0 }] },
    async collect(keys) { return keys.map(key => ({ key, title: '作家 · 第 3 章', fileName: 'game.dshsave', content: Buffer.from('save-bytes') })) },
    async importOne() { return { chatId: 'chat-new', sessionId: 'session-new', title: '作家 · 第 3 章 (2)' } },
    async importedHashes() { return new Set() }
  }
  const memory = {
    async list() { return [{ key: 'chat-1', title: '作家 · 第 3 章', meta: '2 轮召回记录', bytes: 120 }] },
    async collect(keys) { return keys.map(key => ({ key, title: '作家 · 第 3 章', fileName: key + '.recalls.json', content: Buffer.from('{"spec":"dsh-tavern.transfer.recalls","version":1,"records":[{"turn":3,"operationId":"op-1","log":{}}]}') })) },
    async importOne(payload) { merged.push({ chatId: payload.chatId, sessionId: payload.sessionId }); return { added: 1, skipped: 0 } }
  }
  const to = environment({ chats, memory })
  const withSave = await bundleFrom(to, { chats: ['chat-1'], memory: ['chat-1'] })
  assert.deepEqual(withSave.manifest.parts.map(part => part.kind), ['chats', 'memory'])
  const preview = await to.importer.preview(withSave.manifest, withSave.files)
  const part = preview.parts.find(row => row.kind === 'memory')
  assert.equal(part.importable, true)
  assert.equal(part.items[0].usable, true)

  const result = await to.importer.apply({ manifest: withSave.manifest, files: withSave.files,
    selection: { chats: ['chat-1'], memory: ['chat-1'] } })
  assert.equal(result.results.find(row => row.kind === 'memory').added, 1)
  assert.deepEqual(merged, [{ chatId: 'chat-new', sessionId: 'session-new' }])

  // 只带记忆、不带存档：预览就说明无处可并，应用时不写、并记一条失败原因。
  const memoryOnly = await bundleFrom(to, { memory: ['chat-1'] })
  const lonely = (await to.importer.preview(memoryOnly.manifest, memoryOnly.files)).parts.find(row => row.kind === 'memory')
  assert.equal(lonely.items[0].usable, false)
  assert.match(lonely.items[0].reason, /无处可并/)
  const skipped = await to.importer.apply({ manifest: memoryOnly.manifest, files: memoryOnly.files })
  const row = skipped.results.find(item => item.kind === 'memory')
  assert.equal(row.added, 0)
  assert.equal(row.failed.length, 1, '应用时也说明一遍，不静默丢掉')
  assert.match(row.failed[0].error, /无处可并/)
  assert.equal(merged.length, 1, '没有新局，不会再写记忆')
})

test('同一个包再导一次：内容已在本机就不落盘，也不生成第二份副本', async () => {
  const from = environment()
  const bundle = await bundleFrom(from, { cards: ['cards/作家.json'] })
  const to = environment({ cards: new Map() })
  const steps = []
  const first = await to.importer.apply({
    manifest: bundle.manifest, files: bundle.files,
    onProgress: step => steps.push(step)
  })
  assert.equal(first.results[0].added, 1)
  assert.deepEqual(steps.map(step => step.kind), ['cards', 'cards'], '每个板块和每一项都上报进度')
  assert.equal(steps.at(-1).total, 1)
  assert.equal(steps.at(-1).items, 1)

  // 手机端等不到回包又点了一次：包还是一模一样，写之前就该认出内容相同。
  const again = await to.importer.apply({ manifest: bundle.manifest, files: bundle.files })
  const row = again.results.find(item => item.kind === 'cards')
  assert.equal(row.added, 0, '不再新建副本')
  assert.equal(row.skipped, 1)
  assert.deepEqual(row.duplicates, ['作家'])
  assert.equal(to.state.imported.cards.length, 1, '第二次没有写文件')
  assert.deepEqual([...to.state.cards.keys()], ['cards/作家.json'])
})

test('对话「只导最新进度」：策略 latest 传给存档导入，new 保持完整历史', async () => {
  const seen = []
  const chats = {
    async list() { return [] },
    async collect(keys) { return keys.map(key => ({ key, title: '作家 · 第 3 章', fileName: 'game.dshsave', content: Buffer.from('save-bytes') })) },
    async importOne(payload) { seen.push(payload.latestOnly === true); return { chatId: 'chat-new', sessionId: 'session-new', title: '作家 · 第 3 章' } },
    async importedHashes() { return new Set() }
  }
  const to = environment({ chats })
  const bundle = await bundleFrom(to, { chats: ['chat-1'] })
  await to.importer.apply({ manifest: bundle.manifest, files: bundle.files, policies: { chats: 'latest' } })
  await to.importer.apply({ manifest: bundle.manifest, files: bundle.files, policies: { chats: 'new' } })
  assert.deepEqual(seen, [true, false])
})
