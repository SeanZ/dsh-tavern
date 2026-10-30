import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../tavern-plugin/src/client/features/stage-settings.js', import.meta.url), 'utf8')
const runtime = readFileSync(new URL('../tavern-plugin/src/client/features/stage-runtime.js', import.meta.url), 'utf8')
const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() })
const expand = node => typeof node?.type === 'function' ? expand(node.type({ ...node.props })) : node && typeof node === 'object' ? { ...node, children: (node.children || []).map(expand) } : node
const find = (node, test) => !node || typeof node !== 'object' ? null : test(node) ? node : (node.children || []).reduce((found, child) => found || find(child, test), null)
const all = (node, test, out = []) => { if (node && typeof node === 'object') { if (test(node)) out.push(node); (node.children || []).forEach(child => all(child, test, out)) } return out }
const text = node => typeof node === 'string' ? node : node && typeof node === 'object' ? (node.children || []).map(text).join('') : ''

// useState hands out the given states in call order, so a test can render a page as it looks after loading.
function load({ states = [], ...context } = {}) {
  const queue = [...states]
  const React = { createElement: h, Fragment: 'Fragment', useState: init => [queue.length ? queue.shift() : init, () => {}], useRef: () => ({ current: null }), useEffect() {},
    useSyncExternalStore: (subscribe, get) => get() }
  return vm.runInNewContext(source + '; ({ TAVERN_STAGE_TABS, tavernStageReturn, registerTavernStagePanels, TavernStageSwitches, TavernStageSettingsTab, TavernStageMaterialsTab, TavernVoiceTab })', {
    React, DshUi: {}, Date, Set, window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} }, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } },
    useTavernSpeechSettings: () => ({ enabled: false }), useTavernStageView: () => ({ views: [] }), TavernStageViewSwitch: 'ViewSwitch', TavernSpeechSettings: 'SpeechSettings',
    rpc: async () => ({}), tavernSpeechSettings: { set() {} }, tavernStageRuntime: { refresh: async () => {} },
    useTavernKindPacks: () => [], TavernStageKindJump: 'KindJump', TavernStagePacks: 'StagePacks', TavernPackLibrary: 'Library', tavernAssetNav: { go() {} }, TavernStageSkinRows: 'SkinRows', ...context
  })
}
const rowsOf = tree => all(tree, node => /dsh-tavern-switch-row/.test(node.props.className || '')).map(row => ({ row, label: text(find(row, node => node.props.className === 'dsh-tavern-switch-name')), input: find(row, node => node.type === 'input') }))

test('three stage panels are registered like the reference design: 舞台设置, 舞台素材 and 配音', () => {
  const tabs = []
  const { registerTavernStagePanels } = load({ openTavernSidebarTab: () => {} })
  registerTavernStagePanels({ effect: fn => fn(), betterSidebar: { registerTab: tab => { tabs.push(tab); return () => {} } }, sessions: {} })
  assert.deepEqual(tabs.map(tab => [tab.id, tab.title, tab.order, tab.single]), [
    ['dsh-tavern:stage-settings', '舞台设置', 9, true], ['dsh-tavern:stage-materials', '舞台素材', 9.5, true], ['dsh-tavern:voice', '配音', 10, true]])
  // Neither id is claimed by a start-page group, so they are listed under 「其他」; the chip calls icon(size), the start page renders it.
  assert.equal(tabs[0].icon(20).props.width, 20)
  assert.equal(tabs[2].icon({ size: 24 }).props.width, 24)
})


test('基础设置 lists 对话气泡, 配音 ›, 舞台模式, BGM, 音效, 环境音, 物品 and 入场演出 in order; every switch is global and writes its own owner', async () => {
  const calls = [], events = [], opened = []
  const { TavernStageSwitches, tavernStageReturn } = load({
    states: [{ castPresentation: true, stageToggles: { stage: false, music: true } }, 'idle', ''],    useTavernSpeechSettings: () => ({ enabled: true }),
    rpc: async (method, args) => { calls.push([method, args]); return method === 'updateTavernSettings' ? { settings: { castPresentation: true, stageToggles: { stage: true } } } : { enabled: args.enabled } },
    window: { addEventListener() {}, removeEventListener() {}, dispatchEvent: event => events.push(event.type) },
    tavernSpeechSettings: { set: value => calls.push(['speech-store', value]) },
    tavernStageRuntime: { refresh: async id => calls.push(['refresh', id]) }
  })
  const tree = expand(TavernStageSwitches({ sessionId: 'game', openTab: id => opened.push(id) }))
  assert.equal(text(find(tree, node => node.type === 'h3')), '基础设置')
  assert.match(find(tree, node => node.props.className === 'dsh-tavern-switch-help').props.title, /对所有卡生效/)
  const rows = rowsOf(tree)
  assert.deepEqual(rows.map(row => [row.label, row.input.props.checked, row.input.props.disabled]), [['对话气泡', true, false], ['配音', true, false], ['舞台模式', false, false], ['BGM?', true, true], ['音效?', true, true], ['环境音?', true, true], ['物品?', true, true], ['入场演出?', true, true]])
  assert.deepEqual(rows.map(row => row.input.props.role), ['switch', 'switch', 'switch', 'switch', 'switch', 'switch', 'switch', 'switch'])
  for (const row of rows.slice(3)) assert.match(find(row.row, node => node.props.className === 'dsh-tavern-switch-help').props.title, /需要舞台模式/, 'sounds, items and the entrance play on the stage')
  await rows[0].input.props.onChange({ target: { checked: false } })
  await rows[1].input.props.onChange({ target: { checked: false } })
  await rows[2].input.props.onChange({ target: { checked: true } })
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['updateTavernSettings', { patch: { castPresentation: false } }], ['refresh', 'game'],
    ['updateSpeechSettings', { enabled: false }], ['speech-store', { enabled: false }],
    ['updateTavernSettings', { patch: { stageToggles: { stage: true } } }], ['refresh', 'game']])
  assert.deepEqual(events, ['dsh-tavern-settings-changed', 'dsh-tavern-settings-changed', 'dsh-tavern-settings-changed'])
  // 配音 › opens the 配音 panel and leaves the way back to 舞台设置.
  find(rows[1].row, node => node.props['aria-label'] === '声音设置').props.onClick()
  assert.deepEqual(opened, ['dsh-tavern:voice'])
  assert.equal(tavernStageReturn.get().toTab, 'dsh-tavern:stage-settings')
  assert.equal(rows[1].row.props.className, 'dsh-tavern-switch-row is-openable')
})

// 音效: the same shape as 物品 (stageToggles.sfx); its › opens the sound effects of this card's packs.
test('舞台设置 and 舞台素材 follow the game; the asset library stays reachable outside a game', () => {
  const page = mode => ({ useTavernSessionMode: () => mode, isPlayMode: value => value === 'story', useTavernStageRuntime: () => ({ data: { enabled: false, cast: [] } }),
    useScopedLiveTavernView: () => ({ view: { card: { path: 'cards/a.json' } } }), TavernCastManager: 'Cast' })
  const sessions = { subagentAddress: () => ({ parentSessionId: 'game' }) }
  const settings = load(page('story')).TavernStageSettingsTab({ sessionId: 'sub', sessions })
  assert.equal(settings.props['aria-label'], '舞台设置')
  const switches = find(settings, node => typeof node.type === 'function' && node.type.name === 'TavernStageSwitches')
  assert.deepEqual([switches.props.sessionId, switches.props.path], ['game', 'cards/a.json'])
  assert.equal(find(settings, node => node.type === 'StagePacks').props.path, 'cards/a.json', '舞台设置 › 素材包 lists this card\'s packs')
  const materials = load(page('story')).TavernStageMaterialsTab({ sessionId: 'game', sessions })
  assert.equal(materials.props['aria-label'], '舞台素材')
  assert.equal(find(materials, node => node.type === 'Library').props.cardPath, 'cards/a.json', 'pack states are this card\'s')
  assert.equal(find(materials, node => node.type === 'Cast').props.sessionId, 'game', 'cast material is editable while the stage is off')
  const empty = load(page('chat')).TavernStageMaterialsTab({ sessionId: 'game', sessions, openTab: () => {} })
  assert.equal(find(empty, node => node.type === 'Cast'), null)
  assert.equal(find(empty, node => node.type === 'Library').props.cardPath, '', 'without a game: every pack, 全局 / 关闭')
  const settingsOutside = load(page('chat')).TavernStageSettingsTab({ sessionId: 'game', sessions, openTab: () => {} })
  assert.ok(find(settingsOutside, node => text(node) === '未打开人物卡'))
})

test('配音 is the voicing service page, with ‹ back to 舞台设置 when it was opened from there', () => {
  const opened = []
  const { TavernVoiceTab, tavernStageReturn } = load()
  let tab = TavernVoiceTab({ openTab: id => opened.push(id) })
  assert.equal(tab.props['aria-label'], '配音')
  assert.ok(find(tab, node => node.type === 'SpeechSettings'))
  assert.equal(find(tab, node => node.type === 'button'), null)
  tavernStageReturn.set({ toTab: 'dsh-tavern:stage-settings', label: '返回舞台设置' })
  tab = TavernVoiceTab({ openTab: id => opened.push(id) })
  find(tab, node => node.props['aria-label'] === '返回舞台设置').props.onClick()
  assert.deepEqual(opened, ['dsh-tavern:stage-settings'])
  assert.equal(tavernStageReturn.get(), null, 'the way back is used once')
})

// 默认皮肤 / 本卡皮肤 (stage-skins.js): after 舞台模式, before BGM; each picker saves its own owner at once.
const skins = readFileSync(new URL('../tavern-plugin/src/client/features/stage-skins.js', import.meta.url), 'utf8')
test('默认皮肤 and 本卡皮肤 follow 舞台模式; each pick writes its own owner and the open stage re-reads its skin', async () => {
  const { TavernStageSwitches } = load({ states: [{ castPresentation: true, stageToggles: { stage: true, music: true } }, 'idle', ''] })
  const tree = expand(TavernStageSwitches({ sessionId: 'game', path: 'cards/a.json' }))
  const order = all(tree, node => node.type === 'SkinRows' || /dsh-tavern-switch-row/.test(node.props.className || '')).map(node => node.type === 'SkinRows' ? 'skins' : text(find(node, child => child.props.className === 'dsh-tavern-switch-name')))
  assert.deepEqual(order, ['对话气泡', '配音', '舞台模式', 'skins', 'BGM', '音效', '环境音', '物品', '入场演出'])
  assert.equal(find(tree, node => node.type === 'SkinRows').props.path, 'cards/a.json')

  const classic = { id: 'classic', textbox: { paint: { bg: '#000000', fg: '#ffffff' } }, nameplate: { paint: { bg: '#000000', fg: '#ffffff' } } }
  const paper = { ...classic, id: 'paper' }, ref = { packId: 'p', kind: 'skins', assetId: 'paper' }
  const state = { global: 'classic', globalChoices: [{ value: 'classic', label: '经典', document: classic }],
    card: { choice: null, cardDefault: null, skin: ref, fallback: ref, choices: [{ value: 'classic', label: '经典', document: classic }, { value: ref, label: '纸', document: paper, pack: '本卡' }] } }
  const calls = [], saved = []
  const React = { createElement: h, Fragment: 'Fragment', useState: () => [state, () => {}], useCallback: fn => fn, useEffect() {}, useRef: () => ({ current: null }) }
  const { TavernStageSkinRows } = vm.runInNewContext(skins + '; ({ TavernStageSkinRows })', { React, JSON, Promise,
    rpc: async (method, args) => { calls.push([method, args]); return {} }, window: { addEventListener() {}, removeEventListener() {}, dispatchEvent: event => calls.push([event.type]) },
    CustomEvent: class { constructor(type) { this.type = type } }, tavernStageRuntime: { refresh: async id => calls.push(['refresh', id]) }, TAVERN_ASSET_EVENT: 'assets',
    TavernAssetMenu: 'Menu', TavernAssetGlyph: 'Glyph', tavernAssetErrorText: () => '' })
  const rows = expand(TavernStageSkinRows({ path: 'cards/a.json', sessionId: 'game', busy: false, save: job => { saved.push(job); return job() } }))
  const pickers = all(rows, node => node.type === 'Menu')
  assert.deepEqual([...pickers.map(menu => menu.props.label)], ['默认皮肤', '本卡皮肤'])
  // 本卡皮肤 opens with 「跟随默认」, drawn as the skin this card falls back to.
  const card = pickers[1].props.content(() => {}).map(expand)
  assert.deepEqual([...card.map(option => text(option))], ['跟随默认', '经典', '纸'])
  assert.equal(find(card[0], node => /dsh-tavern-skin-art-box/.test(node.props.className || '')) !== null, true)
  await pickers[1].props.content(() => {})[2].props.onClick()
  await pickers[0].props.content(() => {})[0].props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(saved.length, 1, 'picking the current value writes nothing')
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(call => call[0] !== 'getStageSkins'))), [['setCardStageSkin', { path: 'cards/a.json', skin: ref }], ['dsh-tavern-settings-changed'], ['refresh', 'game']])
})

// 环境音: the same shape as 音效 (stageToggles.ambience); its › opens the ambience of this card's packs.
