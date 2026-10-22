import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

// Fork contract C7: tavernStory.render draws a floor and captures its static snapshot.
const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
function setup(t, { retained = false } = {}) {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true })
  const win = dom.window
  if (retained) win.Element.prototype.moveBefore = function (node, child) { this.insertBefore(node, child) }
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  Object.assign(globalThis, { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true })
  let descriptor
  win.__ModuleLoader__ = { load(value) { descriptor = value } }
  const fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: false, error: 'not in test' }) })
  win.fetch = fetch
  const context = vm.createContext({ window: win, document: win.document, navigator: win.navigator, fetch, performance, console, setTimeout, clearTimeout, AbortController, CustomEvent: win.CustomEvent })
  vm.runInContext(source, context)
  const ui = { MarkdownText: props => React.createElement('p', { className: 'markdown' }, props.text) }
  const client = descriptor.factory(name => name === 'react' ? React : name === '@deepseek-ai/dsh-client-ui-primitives' ? ui : {})
  const render = client.createTavernStoryRender({ executeSlash: async () => {} })
  const root = createRoot(win.document.querySelector('main'))
  t.after(() => { act(() => root.unmount()); Object.assign(globalThis, previous); win.close() })
  return { win, client, render, root }
}
const view = parts => ({ mode: 'story', replyProjections: [{ turn: 2, version: 2, parts }], tavernRuntimePolicy: { trustedCardMode: false }, tavernHelper: { messages: [] } })

test('sanitizeHtml 去掉脚本、内嵌框架、事件属性与脚本链接，页面级样式改为楼层作用域', t => {
  const { render } = setup(t)
  const html = render.sanitizeHtml('<style>body{color:red} html, .x{margin:0}</style><div onclick="steal()">卡片<script>evil()</script><iframe src="x"></iframe>'
    + '<a href="javascript:alert(1)">坏</a><a href="https://example.com">好</a><img src="data:text/html,x"><img src="data:image/png;base64,AA"></div>')
  assert.doesNotMatch(html, /script|iframe|onclick|javascript:|data:text/)
  assert.match(html, /:host\{color:red\}/)
  assert.match(html, /:host, \.x\{/)
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">好<\/a>/)
  assert.match(html, /data:image\/png/)
})

test('FloorBody 非 live：快照或无脚本 HTML 放进 shadow root，不建 iframe', async t => {
  const { win, client, render, root } = setup(t)
  client.liveTavernView.setView('s1', view([{ kind: 'markdown', text: '正文' }, { kind: 'html', content: '<div onclick="x()" class="card">卡<script>evil()</script></div><button>继续</button>' }]))
  await act(async () => root.render(React.createElement(render.FloorBody, { sessionId: 's1', storyTurn: 2 })))
  const body = win.document.querySelector('[data-tavern-floor="2"]')
  assert.equal(body.querySelector('.markdown').textContent, '正文')
  const shadow = body.querySelector('.dsh-tavern-floor-static').shadowRoot
  assert.equal(shadow.innerHTML, '<div class="card">卡</div><button>继续</button>')
  assert.equal(win.document.querySelectorAll('iframe').length, 0)
  await act(async () => root.render(React.createElement(render.FloorBody, { sessionId: 's1', storyTurn: 2, snapshotHtml: '<p onmouseover="x()">快照</p><script>1</script>' })))
  assert.equal(win.document.querySelector('.dsh-tavern-floor-static').shadowRoot.innerHTML, '<p>快照</p>')
  const projected = await render.projectFloor('s1', 2)
  assert.equal(projected.hasScript, true)
  assert.equal(projected.parts.length, 2)
  assert.equal(projected.trustedCardMode, false)
})

test('FloorBody live 用 Tavern 的消息 frame；离开 live 即释放保留帧', async t => {
  const { win, client, render, root } = setup(t, { retained: true })
  client.liveTavernView.setView('s2', view([{ kind: 'html', content: '<div>卡</div><script>run()</script>' }]))
  await act(async () => root.render(React.createElement(render.FloorBody, { sessionId: 's2', storyTurn: 2, live: true, eager: true })))
  const frames = win.document.querySelectorAll('iframe.dsh-tavern-message-frame')
  assert.equal(frames.length, 1, '带脚本楼层 live 时有一个 iframe')
  assert.equal(frames[0].getAttribute('sandbox'), 'allow-scripts')
  await act(async () => root.render(React.createElement(render.FloorBody, { sessionId: 's2', storyTurn: 2, live: false })))
  assert.equal(win.document.querySelectorAll('iframe').length, 0, '不再 live 后 iframe 立即销毁，不停放在页面里')
})

test('captureFloorSnapshot 读 frame 与正文 DOM，去脚本与事件属性，并标记截断', async t => {
  const { win, render } = setup(t)
  const container = win.document.createElement('div')
  container.innerHTML = '<div><p>正文<b>段落</b></p></div><div><iframe class="dsh-tavern-message-frame"></iframe></div>'
  win.document.body.appendChild(container)
  const frameDoc = container.querySelector('iframe').contentDocument
  frameDoc.body.innerHTML = '<style>body{background:#000}</style><div onclick="x()">卡片面板<script>evil()</script></div>'
  const result = await render.captureFloorSnapshot(container)
  assert.equal(result.frames, 1)
  assert.equal(result.truncated, false)
  assert.equal(result.html, '<div><p>正文<b>段落</b></p></div><div><style>:host{background:#000}</style><div>卡片面板</div></div>')
  const small = await render.captureFloorSnapshot(container, { bytes: 20 })
  assert.equal(small.truncated, true)
  await assert.rejects(render.captureFloorSnapshot(null), /楼层容器/)
})
