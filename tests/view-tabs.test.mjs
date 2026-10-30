import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

import {
  VIEW_TAB_RESIDENT, applyTavernSettingsPatch, presentTavernSettings, readViewTabs, viewTabs
} from '../tavern-plugin/lib/domain/tavern-settings.js'

const client = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
const moduleSource = await readFile(new URL('../tavern-plugin/src/client/modules/view-tabs.js', import.meta.url), 'utf8')

const TAB_ENTRIES = [
  { id: 'chat', label: '对话' },
  { id: 'trajectory', label: '轨迹' },
  { id: 'dsh-tavern:full-context', label: '完整上下文' },
  { id: 'dsh-tavern:gallery', label: '画廊' },
  { id: 'dsh-tavern:polish', label: '精修' }
]
const TAB_IDS = TAB_ENTRIES.map(entry => entry.id)
const DEFAULT_IDS = TAB_IDS.filter(id => id !== 'dsh-tavern:full-context')
const json = value => JSON.parse(JSON.stringify(value))

// 宿主 slots.entries 按 priority、order 升序给出：order -10 的故事排在对话前面。
const STORY_SLOTS = {
  entries: () => [
    { options: { id: 'tavern-story', label: '故事', order: -10 } },
    { options: { id: 'chat', label: () => '对话', order: 0 } },
    { options: { id: 'trajectory', label: '轨迹', order: 1 } },
    { options: { id: 'dsh-tavern:full-context', label: '完整上下文', order: 11 } },
    { options: { id: 'dsh-tavern:gallery', label: '画廊', order: 12 } },
    { options: { id: 'dsh-tavern:polish', label: '精修', order: 13 } }
  ]
}

test('顶部标签未设置时服务端下发 null，对话固定首位；保存、读取与恢复默认都守住这条', () => {
  assert.equal(VIEW_TAB_RESIDENT, 'chat')
  assert.equal(presentTavernSettings({}, {}).viewTabs, null)

  // 对话不在清单里时补到首位；排在后面时挪回首位。
  assert.deepEqual(viewTabs({ items: ['dsh-tavern:gallery'] }).items, ['chat', 'dsh-tavern:gallery'])
  assert.deepEqual(viewTabs({ items: ['dsh-tavern:gallery', 'chat', 'trajectory'] }).items, ['chat', 'dsh-tavern:gallery', 'trajectory'])
  // 去重、截断、非法值。
  assert.deepEqual(viewTabs({ items: ['chat', 'chat', 'dsh-tavern:gallery'] }).items, ['chat', 'dsh-tavern:gallery'])
  assert.equal(viewTabs({ items: Array.from({ length: 30 }, (_, index) => 'dsh-tavern:page-' + index) }).items.length, 24)
  for (const bad of [null, [], { items: 'chat' }, { items: ['bad id'] }, { items: [1] }]) assert.throws(() => viewTabs(bad), /无效的顶部标签设置/)
  // 无效值按未设置处理。
  assert.equal(readViewTabs({ items: ['bad id'] }), null)
  assert.equal(readViewTabs(undefined), null)

  // 只有对话也被允许：对话不能被移除。
  assert.deepEqual(viewTabs({ items: [] }).items, ['chat'])
  let document = applyTavernSettingsPatch({}, { viewTabs: { items: ['chat', 'dsh-tavern:gallery'] } })
  assert.deepEqual(document.viewTabs, { items: ['chat', 'dsh-tavern:gallery'] })
  assert.deepEqual(presentTavernSettings(document, {}).viewTabs, { items: ['chat', 'dsh-tavern:gallery'] })
  document = applyTavernSettingsPatch(document, { viewTabs: null })
  assert.equal(Object.hasOwn(document, 'viewTabs'), false)
  assert.equal(presentTavernSettings(document, {}).viewTabs, null)
})

function loadModule(extra = {}) {
  const context = vm.createContext(Object.assign({ React }, extra))
  vm.runInContext(moduleSource + '\nthis.api = { tavernViewTabItems, tavernViewTabEntries, tavernViewTabPlan, applyTavernViewTabRow, TavernViewTabsSettings, tavernViewTabCatalog };', context)
  return context.api
}

function tabRow(dom, labels = ['对话', '轨迹', '完整上下文', '画廊', '精修'], active = '画廊') {
  const row = dom.window.document.createElement('div')
  row.setAttribute('data-conversation-tabs', '')
  for (const label of labels) {
    const button = dom.window.document.createElement('button')
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-selected', label === active ? 'true' : 'false')
    button.textContent = label
    row.appendChild(button)
  }
  dom.window.document.body.appendChild(row)
  return row
}

const styleOf = row => Array.from(row.querySelectorAll('button[role="tab"]')).map(button => ({
  label: button.textContent,
  id: button.getAttribute('data-tavern-view-tab'),
  display: button.style.display,
  order: button.style.order
}))

test('客户端标签行按设置的清单显示与排序，隐藏当前标签时切回第一个可见标签', () => {
  const api = loadModule()
  const dom = new JSDOM('<body></body>', { pretendToBeVisual: true })
  try {
    // 默认按注册顺序显示，完整上下文按需添加。
    let row = tabRow(dom)
    assert.equal(api.applyTavernViewTabRow(row, TAB_ENTRIES, api.tavernViewTabItems(null, TAB_ENTRIES)), 4)
    assert.deepEqual(styleOf(row).map(item => [item.id, item.display, item.order]), [
      ['chat', '', '0'], ['trajectory', '', '1'], ['dsh-tavern:full-context', 'none', ''], ['dsh-tavern:gallery', '', '2'], ['dsh-tavern:polish', '', '3']
    ])

    // 只留对话 + 完整上下文，并把画廊藏起来（它正被选中）。
    let clicked = 0
    row.querySelectorAll('button[role="tab"]')[0].addEventListener('click', () => { clicked += 1 })
    assert.equal(api.applyTavernViewTabRow(row, TAB_ENTRIES, ['chat', 'dsh-tavern:full-context']), 2)
    assert.deepEqual(styleOf(row).map(item => item.display === 'none' ? null : item.id).filter(Boolean), ['chat', 'dsh-tavern:full-context'])
    assert.equal(clicked, 1, '当前「画廊」被隐藏后切回「对话」')

    // 开发者工具关闭时宿主不画「轨迹」：按钮少一个也要对齐正确。
    row = tabRow(dom, ['对话', '完整上下文', '画廊', '精修'])
    api.applyTavernViewTabRow(row, TAB_ENTRIES, TAB_IDS)
    assert.deepEqual(styleOf(row).map(item => item.id), ['chat', 'dsh-tavern:full-context', 'dsh-tavern:gallery', 'dsh-tavern:polish'])
  } finally { dom.window.close() }
})

test('客户端清单读取时也把对话补到首位，旧配置或手改配置不会把它删掉', () => {
  const api = loadModule()
  assert.deepEqual(json(api.tavernViewTabItems(null)), ['chat'])
  assert.deepEqual(json(api.tavernViewTabItems(null, TAB_ENTRIES)), DEFAULT_IDS)
  // 保存过的清单优先于派生。
  assert.deepEqual(json(api.tavernViewTabItems({ items: ['dsh-tavern:gallery'] }, TAB_ENTRIES)), ['chat', 'dsh-tavern:gallery'])
  assert.deepEqual(json(api.tavernViewTabItems({ items: ['dsh-tavern:gallery', 'chat'] })), ['chat', 'dsh-tavern:gallery'])
  assert.deepEqual(json(api.tavernViewTabItems({ items: [] })), ['chat'])
})

test('客户端不写死默认清单，标签名称与顺序从槽位读（宿主的名称是函数）', () => {
  assert.doesNotMatch(client, /TAVERN_VIEW_TABS_DEFAULT/)

  const api = loadModule()
  const entries = api.tavernViewTabEntries({
    entries: () => [
      { options: { id: 'chat', label: () => '对话' } },
      { options: { id: 'trajectory', label: '轨迹' } },
      { options: { id: 'dsh-tavern:gallery' } },
      { options: {} }
    ]
  })
  assert.deepEqual(JSON.parse(JSON.stringify(entries)), [
    { id: 'chat', label: '对话', order: 0 },
    { id: 'trajectory', label: '轨迹', order: 0 },
    { id: 'dsh-tavern:gallery', label: 'gallery', order: 0 }
  ])
})

test('设置里的顶部标签：对话锁定首位不可移除，其余可排序/移除/恢复默认', async t => {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true })
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  t.after(() => { Object.assign(globalThis, { window: previous.window, document: previous.document, IS_REACT_ACT_ENVIRONMENT: previous.act }); dom.window.close() })

  const saved = []
  let value = { headerItems: { display: 'icon-text', items: ['dsh-tavern:status'] }, viewTabs: { items: TAB_IDS } }
  const listeners = new Set()
  const displayPreferences = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot: () => value,
    async save(patch) {
      saved.push(JSON.parse(JSON.stringify(patch)))
      value = { ...value, viewTabs: patch.viewTabs === null ? null : { items: viewTabs(patch.viewTabs).items } }
      listeners.forEach(listener => listener())
      return value
    }
  }
  const api = loadModule({ displayPreferences })
  const root = createRoot(dom.window.document.querySelector('main'))
  await act(async () => root.render(React.createElement(api.TavernViewTabsSettings)))
  const press = node => act(async () => { node.click(); await new Promise(resolve => setTimeout(resolve, 0)) })

  const rows = () => [...dom.window.document.querySelectorAll('.dsh-tavern-view-tab-row')]
  const names = () => rows().map(row => row.querySelector('.dsh-tavern-view-tab-name strong').textContent)
  // 未保存且目录未就绪：用内置标签派生。
  assert.deepEqual(names(), ['对话', '轨迹', '完整上下文', '画廊', '精修'])
  // 对话：固定标记，没有上移/下移/移除。
  assert.equal(rows()[0].querySelector('.dsh-tavern-view-tab-lock').textContent, '固定')
  assert.equal(rows()[0].querySelectorAll('button').length, 0)
  // 第二行不能上移（对话永远第一）。
  assert.equal(rows()[1].querySelector('[aria-label="上移"]').disabled, true)

  // 移除「画廊」。
  const remove = rows()[3].querySelector('[aria-label="移除"]')
  await press(remove)
  assert.deepEqual(saved.at(-1), { viewTabs: { items: ['chat', 'trajectory', 'dsh-tavern:full-context', 'dsh-tavern:polish'] } })
  assert.deepEqual(names(), ['对话', '轨迹', '完整上下文', '精修'])
  const chip = [...dom.window.document.querySelectorAll('.dsh-tavern-view-tab-chip')].find(node => node.textContent.includes('画廊'))
  assert.ok(chip, '移除的标签出现在「可添加的标签」里')

  // 加回「画廊」到末尾。
  await press(chip)
  assert.deepEqual(saved.at(-1), { viewTabs: { items: ['chat', 'trajectory', 'dsh-tavern:full-context', 'dsh-tavern:polish', 'dsh-tavern:gallery'] } })

  // 上移「完整上下文」到「轨迹」前面。
  await press(rows()[2].querySelector('[aria-label="上移"]'))
  assert.deepEqual(saved.at(-1), { viewTabs: { items: ['chat', 'dsh-tavern:full-context', 'trajectory', 'dsh-tavern:polish', 'dsh-tavern:gallery'] } })

  // 恢复默认标签：删除已保存清单，回到派生结果。
  const reset = [...dom.window.document.querySelectorAll('button')].find(node => node.textContent === '恢复默认标签')
  await press(reset)
  assert.deepEqual(saved.at(-1), { viewTabs: null })
  assert.deepEqual(names(), ['对话', '轨迹', '画廊', '精修'])
  assert.ok([...dom.window.document.querySelectorAll('.dsh-tavern-view-tab-chip')].some(node => node.textContent.includes('完整上下文')))
  await act(async () => root.unmount())
})

test('标签行控制模块随 client 一起发布，自定义顶栏里挂上设置', () => {
  assert.match(client, /function installTavernViewTabLayout\(options\)/)
  assert.match(client, /tavernViewTabCatalog\.publish\(tavernViewTabEntries\(slots\)\)/)
  assert.match(client, /"dsh-tavern: view tab layout"/)
  assert.match(client, /TAVERN_VIEW_TAB_RESIDENT = "chat"/)
  assert.match(client, /h\(TavernViewTabsSettings\)/)
  assert.match(client, /title: "拖动排序"/)
})


test('外部插件页签按槽位顺序排在对话前时，默认清单对话首位、故事第二且保持可见', () => {
  const api = loadModule()
  const dom = new JSDOM('<body></body>', { pretendToBeVisual: true })
  try {
    const entries = api.tavernViewTabEntries(STORY_SLOTS)
    assert.deepEqual(json(entries.slice(0, 2)), [{ id: 'tavern-story', label: '故事', order: -10 }, { id: 'chat', label: '对话', order: 0 }])
    const items = api.tavernViewTabItems(presentTavernSettings({}, {}).viewTabs, entries)
    assert.deepEqual(json(items), ['chat', 'tavern-story', 'trajectory', 'dsh-tavern:gallery', 'dsh-tavern:polish'])
    // 宿主渲染：对话固定第一，其余按 order。
    const row = tabRow(dom, ['对话', '故事', '轨迹', '完整上下文', '画廊', '精修'], '故事')
    let clicks = 0
    row.querySelector('button').addEventListener('click', () => { clicks += 1 })
    assert.equal(api.applyTavernViewTabRow(row, entries, items), 5)
    const story = styleOf(row).find(item => item.id === 'tavern-story')
    assert.deepEqual([story.display, story.order], ['', '1'])
    assert.deepEqual(styleOf(row)[0], { label: '对话', id: 'chat', display: '', order: '0' })
    assert.equal(clicks, 0)
  } finally { dom.window.close() }
})

test('标签行只有对话与故事且当前为故事时，不触发切回对话', () => {
  const api = loadModule()
  const dom = new JSDOM('<body></body>', { pretendToBeVisual: true })
  try {
    const entries = api.tavernViewTabEntries({ entries: () => STORY_SLOTS.entries().slice(0, 2) })
    const row = tabRow(dom, ['对话', '故事'], '故事')
    let clicks = 0
    for (const button of row.querySelectorAll('button')) button.addEventListener('click', () => { clicks += 1 })
    assert.equal(api.applyTavernViewTabRow(row, entries, api.tavernViewTabItems(null, entries)), 2)
    assert.deepEqual(styleOf(row).map(item => [item.id, item.display]), [['chat', ''], ['tavern-story', '']])
    assert.equal(clicks, 0)
  } finally { dom.window.close() }
})

test('按钮文字都取不到时按位置兜底，对话先提到首位，不会被隐藏或配给故事', () => {
  const api = loadModule()
  const dom = new JSDOM('<body></body>', { pretendToBeVisual: true })
  try {
    const entries = api.tavernViewTabEntries(STORY_SLOTS)
    const row = tabRow(dom, entries.map(() => ''), '')
    // 只保存了对话与画廊：位置错一格就会隐藏对话或把故事配到对话按钮上。
    assert.equal(api.applyTavernViewTabRow(row, entries, ['chat', 'dsh-tavern:gallery']), 2)
    const plan = styleOf(row)
    assert.deepEqual(plan[0], { label: '', id: 'chat', display: '', order: '0' })
    assert.equal(plan[1].id, 'tavern-story')
    assert.equal(plan[1].display, 'none')
    assert.deepEqual(plan.map(item => item.id), ['chat', 'tavern-story', 'trajectory', 'dsh-tavern:full-context', 'dsh-tavern:gallery', 'dsh-tavern:polish'])
  } finally { dom.window.close() }
})

test('没有注册故事页签时派生清单与设置页都没有它；注册后设置页排在对话后面', async t => {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true })
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  t.after(() => { Object.assign(globalThis, { window: previous.window, document: previous.document, IS_REACT_ACT_ENVIRONMENT: previous.act }); dom.window.close() })

  const preferences = { viewTabs: null }
  const displayPreferences = { subscribe: () => () => {}, snapshot: () => preferences, async save() {} }
  const api = loadModule({ displayPreferences })
  const withoutStory = api.tavernViewTabEntries({ entries: () => STORY_SLOTS.entries().slice(1) })
  assert.equal(api.tavernViewTabItems(null, withoutStory).includes('tavern-story'), false)

  api.tavernViewTabCatalog.publish(withoutStory)
  const root = createRoot(dom.window.document.querySelector('main'))
  await act(async () => root.render(React.createElement(api.TavernViewTabsSettings)))
  const names = () => [...dom.window.document.querySelectorAll('.dsh-tavern-view-tab-row .dsh-tavern-view-tab-name strong')].map(node => node.textContent)
  assert.deepEqual(names(), ['对话', '轨迹', '画廊', '精修'])
  assert.equal(dom.window.document.querySelector('.dsh-tavern-view-tabs').textContent.includes('故事'), false)

  await act(async () => api.tavernViewTabCatalog.publish(api.tavernViewTabEntries(STORY_SLOTS)))
  assert.deepEqual(names(), ['对话', '故事', '轨迹', '画廊', '精修'])
  await act(async () => root.unmount())
})
