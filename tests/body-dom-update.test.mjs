import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'
import { renderBodyMarkdown } from '../tavern-plugin/lib/domain/body-renderer.js'
import bodyDom from '../tavern-plugin/lib/domain/body-dom.cjs'

const source = await readFile(new URL('../tavern-plugin/src/client/body-markdown.js', import.meta.url), 'utf8')
function fixture(t) {
  const dom = new JSDOM('<main></main>')
  t.after(() => dom.window.close())
  const host = dom.window.document.querySelector('main')
  let effect
  const context = {
    renderBodyMarkdown, ...bodyDom, DshUi: {}, ReactDOM: {},
    installTavernTextColors: () => ({ dispose() {} }), findTavernQuoteRanges() {}, bindTavernFontZoom: () => () => {},
    React: { useRef: () => ({ current: host }), useState: () => [[], () => {}], useMemo: fn => fn(), useLayoutEffect: fn => { effect = fn }, createElement() {} }
  }
  vm.runInNewContext(source + ';this.render = TavernBodyMarkdown;this.patch = patchTavernBodyDom', context)
  return { host, document: dom.window.document, patch: context.patch, render(prepared) { context.render({ prepared, trustedCardMode: true }); return effect() } }
}
function slots(ids) {
  return { text: ids.map(id => '<span data-dsh-body-slot="' + id + '"></span>').join('\n'), slots: ids.map(id => ({ id, block: true, node: null })) }
}

test('连续气泡槽按原文顺序放置，流式追加保留已有挂载点', t => {
  const { host, render } = fixture(t)
  const dispose = render(slots(['first']))
  const first = host.querySelector('[data-dsh-body-mount="first"]')
  dispose()
  render(slots(['first', 'second']))
  assert.deepEqual([...host.querySelectorAll('[data-dsh-body-mount]')].map(node => node.getAttribute('data-dsh-body-mount')), ['first', 'second'])
  assert.equal(host.querySelector('[data-dsh-body-mount="first"]'), first)
})

test('插入、重排、移除挂载点不会移除仍存在的 portal 容器或其子树', t => {
  const { host, document, patch } = fixture(t)
  function update(ids) {
    const next = document.createElement('template')
    next.innerHTML = ids.map(id => '<div data-dsh-body-mount="' + id + '"></div>').join('')
    patch(host, next.content)
  }
  update(['a', 'b'])
  const a = host.children[0], b = host.children[1]
  a.innerHTML = '<button>播放</button>'
  const button = a.firstChild
  update(['new', 'b', 'a'])
  assert.equal(host.children[1], b)
  assert.equal(host.children[2], a)
  assert.equal(a.firstChild, button)
  update(['a'])
  assert.equal(host.children.length, 1)
  assert.equal(host.firstChild, a)
})

test('用户展开 details 后正文增量更新保留展开状态', t => {
  const { host, document, patch } = fixture(t)
  const next = document.createElement('template')
  next.innerHTML = '<details><summary>标题</summary><p>第一段</p></details>'
  patch(host, next.content)
  const details = host.firstChild
  details.open = true
  next.content.querySelector('p').textContent = '更新正文'
  patch(host, next.content)
  assert.equal(host.firstChild, details)
  assert.equal(details.open, true)
  assert.equal(details.querySelector('p').textContent, '更新正文')
})

test('纯 Markdown 保留正文排版，作者 HTML 与流式原文不重排', () => {
  const context = { layoutTavernProseText: text => text.replace('第一句。第二句。', '第一句。\n\n第二句。') }
  vm.runInNewContext(source + ';this.layout = layoutTavernBodyText', context)
  assert.equal(context.layout('第一句。第二句。', false), '第一句。\n\n第二句。')
  assert.equal(context.layout('第一句。第二句。', true), '第一句。第二句。')
  const html = '<div>第一句。第二句。</div>'
  assert.equal(context.layout(html, false), html)
  const slot = '<span data-dsh-body-slot="slot"></span>'
  assert.equal(context.layout('第一句。第二句。\n'+slot, false), '第一句。\n\n第二句。\n'+slot)
})

for (const opening of ['<details><summary>回忆</summary>\n','<div>\n']) test('未闭合容器仍保留已登记业务槽：'+opening,t=>{
 const {host,render}=fixture(t)
 const prepared=slots(['bubble']);prepared.text=opening+'前文\n\n'+prepared.text+'\n\n后文'
 render(prepared)
 assert.equal(host.querySelectorAll('[data-dsh-body-mount="bubble"]').length,1)
 assert.equal(host.textContent.includes('data-dsh-body-slot'),false)
})

test('独立块槽原位替换其空段落，保留气泡两侧叙述顺序',t=>{
 const {host,render}=fixture(t)
 const prepared=slots(['bubble']);prepared.text='前文\n\n'+prepared.text+'\n\n后文'
 render(prepared)
 const content=host.querySelector('.dsh-tavern-body-content')
 assert.deepEqual([...content.children].map(node=>node.textContent||node.getAttribute('data-dsh-body-mount')),['前文','bubble','后文'])
})

test('相同正文重绘保留受控舞台入口按钮',t=>{
 const {host,document,patch}=fixture(t),next=document.createElement('template')
 next.innerHTML='<p>正文</p>';patch(host,next.content)
 const button=document.createElement('button');button.className='fork-stage-enter-here';button.setAttribute('data-fork-stage-source','source');host.firstChild.appendChild(button)
 patch(host,next.content)
 assert.equal(host.querySelector('button'),button)
})

test('保留业务按钮后追加行内节点，入口仍位于段尾',t=>{
 const {host,document,patch}=fixture(t),next=document.createElement('template')
 next.innerHTML='<p>正文</p>';patch(host,next.content)
 const button=document.createElement('button');button.className='fork-stage-enter-here';button.setAttribute('data-fork-stage-source','source');host.firstChild.appendChild(button)
 next.innerHTML='<p>正文<br>第二行</p>';patch(host,next.content)
 assert.equal(host.firstChild.lastChild,button)
})
