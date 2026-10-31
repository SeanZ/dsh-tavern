import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

// 实际构建客户端与 React：只替换媒体 RPC，不替换故事渲染和上游配图组件。
const source = (await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8'))
  .replace('exports.createTavernStoryRender = createTavernStoryRender;',
    'exports.createTavernStoryRender = createTavernStoryRender; exports.fixtureUi = tavernUiExtensions.service;')
async function setup(t) {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), win = dom.window
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  Object.assign(globalThis, { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true })
  let descriptor, currentView, items = [], draws = []
  win.__ModuleLoader__ = { load(value) { descriptor = value } }
  const fetch = async (url, options) => {
    const args = JSON.parse(options.body)
    const result = url.endsWith('/pluginMediaTurns') ? { turns: [2] }
      : url.endsWith('/pluginMediaForTurn') ? { key: args.sessionId, items }
      : url.endsWith('/getSession') ? { view: currentView } : { scopes: {} }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, ...result }) }
  }
  win.fetch = fetch
  vm.runInContext(source, vm.createContext({ window: win, document: win.document, navigator: win.navigator, fetch, performance, console, setTimeout, clearTimeout, AbortController, URLSearchParams, CustomEvent: win.CustomEvent }))
  const ui = { MarkdownText: props => React.createElement('p', { className: 'markdown' }, props.text), Tooltip: props => props.children }
  const client = descriptor.factory(name => name === 'react' ? React : name === '@deepseek-ai/dsh-client-ui-primitives' ? ui : {})
  const stop = client.fixtureUi.registerIllustrator({ kinds: ['fixture/image'], draw: async value => { draws.push(value) }, redraw: async () => {} })
  const render = client.createTavernStoryRender({}), root = createRoot(win.document.querySelector('main'))
  t.after(() => { act(() => { root.unmount(); stop() }); Object.assign(globalThis, previous); win.close() })
  const view = parts => ({ mode: 'story', replyProjections: [{ turn: 2, version: 2, parts }], tavernRuntimePolicy: { trustedCardMode: false }, tavernHelper: { messages: [] } })
  return { win, client, render, draws, setItems(value) { items = value }, async show(parts, extra = {}) {
    currentView = view(parts)
    await act(async () => client.liveTavernView.setView('story', currentView))
    await act(async () => { root.render(React.createElement(render.FloorBody, { sessionId: 'story', storyTurn: 2, ...extra })); await new Promise(resolve => setTimeout(resolve, 5)) })
  }, async action(disabled = false) {
    await act(async () => root.render(React.createElement(render.IllustrateAction, { sessionId: 'story', storyTurn: 2, disabled })))
  } }
}
const item = (id, anchor = '') => ({ id, kind: 'fixture/image', owner: 'fixture', status: 'ready', anchor, attachment: 'local.png', caption: id, updatedAt: 1 })

test('故事楼层复用上游媒体：正文锚点、未命中兜底与快照不重复', async t => {
  const f = await setup(t)
  f.setItems([item('anchored', '掌柜递来金币。'), item('trailing', '没有这句')])
  await f.show([{ kind: 'markdown', text: '掌柜递来金币。\n\n旅人接过奖励。' }])
  const body = f.win.document.querySelector('[data-tavern-floor]')
  assert.equal(body.querySelectorAll('.dsh-tavern-plugin-media').length, 2)
  assert.equal(body.querySelectorAll('img').length, 2)
  assert.match(body.textContent, /掌柜递来金币。[\s\S]*anchored[\s\S]*旅人接过奖励。[\s\S]*trailing/)
  assert.equal(body.querySelectorAll('button').length > 0, true, '保留上游图片操作')
  const snapshot = await f.render.captureFloorSnapshot(body)
  assert.doesNotMatch(snapshot.html, /plugin-media|anchored|trailing/, '媒体保持动态，不固化进正文快照')
  await f.show([], { snapshotHtml: snapshot.html })
  assert.equal(f.win.document.querySelectorAll('.dsh-tavern-plugin-media').length, 2, '快照楼仍有两张动态媒体')
})

test('无投影兜底和静态 HTML 楼层仍显示当前媒体', async t => {
  const f = await setup(t)
  f.setItems([item('image')])
  await f.show([], { fallbackText: '普通正文' })
  assert.equal(f.win.document.querySelectorAll('img').length, 1)
  await f.show([{ kind: 'html', content: '<div>卡片状态</div>' }])
  assert.equal(f.win.document.querySelectorAll('img').length, 1)
  assert.equal(f.win.document.querySelectorAll('iframe').length, 0)
})

test('公开配图按钮使用故事轮号，遵循禁用和游玩模式', async t => {
  const f = await setup(t)
  await f.show([{ kind: 'markdown', text: '正文' }])
  assert.equal(typeof f.render.IllustrateAction, 'function')
  await f.action(true)
  assert.equal(f.win.document.querySelector('button').disabled, true)
  await f.action(false)
  await act(async () => f.win.document.querySelector('button').click())
  assert.deepEqual(JSON.parse(JSON.stringify(f.draws)), [{ gameId: 'story', turn: 2 }])
  await act(async () => f.client.liveTavernView.setView('story', { mode: 'card' }))
  assert.equal(f.win.document.querySelectorAll('button').length, 0)
})
