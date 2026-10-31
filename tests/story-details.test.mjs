import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import React, {act} from 'react'
import {createRoot} from 'react-dom/client'
import {JSDOM} from 'jsdom'
import {projectReplyLayers} from '../tavern-plugin/lib/domain/reply-presentation.js'

const source=await readFile(new URL('../tavern-plugin/lib/client.js',import.meta.url),'utf8')
function setup(t){
  const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),win=dom.window
  const previous={window:globalThis.window,document:globalThis.document,act:globalThis.IS_REACT_ACT_ENVIRONMENT}
  Object.assign(globalThis,{window:win,document:win.document,IS_REACT_ACT_ENVIRONMENT:true})
  let descriptor
  win.__ModuleLoader__={load(value){descriptor=value}}
  vm.runInContext(source,vm.createContext({window:win,document:win.document,navigator:win.navigator,performance,console,setTimeout,clearTimeout,AbortController}))
  const calls=[]
  const ui={MarkdownText:props=>{calls.push(props.text);return React.createElement('p',{'data-markdown':''},props.text)}}
  const client=descriptor.factory(name=>name==='react'?React:name==='@deepseek-ai/dsh-client-ui-primitives'?ui:{})
  const render=client.createTavernStoryRender({}),root=createRoot(win.document.querySelector('main'))
  t.after(()=>{act(()=>root.unmount());Object.assign(globalThis,previous);win.close()})
  async function show(html,extra={}){
    const projection=projectReplyLayers(html),before=JSON.stringify(projection)
    client.liveTavernView.setView('s',{mode:'story',replyProjections:[{turn:2,version:2,parts:projection.displayParts}],tavernRuntimePolicy:{trustedCardMode:true}})
    await act(async()=>root.render(React.createElement(render.FloorBody,{sessionId:'s',storyTurn:2,...extra})))
    assert.equal(JSON.stringify(projection),before,'显示不得改写投影对象')
  }
  return {win,render,root,calls,show}
}
const plain='<details>\n<summary>隐藏剧情</summary>\n第一段。\n\n**第二段**\n\n- 第一点\n- 第二点\n</details>'

test('故事纯文本 details 原样交给宿主 Markdown，保持默认关闭与原投影',async t=>{
  const {win,calls,show}=setup(t)
  await show(plain)
  assert.equal(new Set(calls).size,1)
  assert.equal(calls[0],'\n第一段。\n\n**第二段**\n\n- 第一点\n- 第二点\n')
  const details=win.document.querySelector('details')
  assert.equal(details.open,false)
  assert.equal(details.querySelector('summary').textContent,'隐藏剧情')
  assert.equal(details.querySelectorAll('[data-markdown]').length,1)
  details.open=true
  await show(plain)
  assert.equal(win.document.querySelector('details'),details)
  assert.equal(details.open,true,'相同输入重复渲染不重置用户展开状态')
  assert.equal(details.querySelectorAll('[data-markdown]').length,1)
})

test('HTML 与嵌套结构保留原路径，不递归处理其内部文本',async t=>{
  const {win,calls,show}=setup(t)
  for(const content of ['<p>第一段</p>','<br>换行','<span>文本</span>','<pre>**代码**</pre>','<!-- 隐藏 -->文本','<details><summary>内层</summary>**内部**</details>']){
    await show('<details><summary>标题</summary>'+content+'</details>')
    assert.equal(calls.length,0,content)
    assert(win.document.querySelector('.dsh-tavern-floor-static').shadowRoot.querySelector('details'))
  }
  for(const html of [plain.replace('<details>','<details class="custom">'),plain.replace('<details>','<details style="color:red">'),'<div>'+plain+'</div>','<style>details{color:red}</style>'+plain,plain.replace('隐藏剧情','<b>标题</b>'),'<details><summary>样式</summary><style>details{display:none}</style></details>'+plain]){
    await show(html)
    assert.equal(calls.length,0,html)
  }
})

test('相邻 HTML 折叠块不妨碍纯文本块；注释不泄漏到 Markdown',async t=>{
  const {win,calls,show}=setup(t)
  await show('<details><summary>内部记录</summary><!-- 不展示 --></details>\n'+plain)
  assert.equal(new Set(calls).size,1)
  assert.equal(win.document.querySelectorAll('details').length,1)
  assert.doesNotMatch(calls[0],/不展示/)
})

test('实体编码的标签与反复刷新只进入 Markdown 一次，无再次分类',async t=>{
  const {win,calls,show}=setup(t)
  const html='<details><summary>标签示例</summary>&lt;details&gt;&lt;summary&gt;示例&lt;/summary&gt;**文字**&lt;/details&gt;</details>'
  for(let i=0;i<15;i++)await show(html,{revision:String(i)})
  assert.equal(new Set(calls).size, 1, "媒体订阅可重渲染，但输入不得被再次分类或改变")
  assert(calls.every(text=>text===calls[0]))
  assert.equal(win.document.querySelectorAll('details').length,1)
  assert.equal(win.document.querySelectorAll('[data-markdown]').length,1)
  assert.equal(calls[0],'<details><summary>示例</summary>**文字**</details>')
})

test('纯文本旧快照可渲染，HTML 快照不二次解析，公共 HTML 与 live 路径不变',async t=>{
  const {win,render,root,calls,show}=setup(t)
  await show('',{snapshotHtml:plain.replace('<details>','<details open>')})
  assert.equal(win.document.querySelector('details').open,true)
  assert.equal(new Set(calls).size,1)
  await show('',{snapshotHtml:'<details open><summary>历史</summary><p><strong>已渲染</strong></p></details>'})
  assert.equal(new Set(calls).size,1)
  assert(win.document.querySelector('.dsh-tavern-floor-static').shadowRoot.querySelector('strong'))
  await act(async()=>root.render(React.createElement(render.StaticHtml,{html:plain})))
  assert.equal(new Set(calls).size,1)
  assert(win.document.querySelector('.dsh-tavern-floor-static').shadowRoot.textContent.includes('**第二段**'))
  await show(plain,{live:true})
  assert.equal(new Set(calls).size,1)
  assert(win.document.querySelector('.dsh-tavern-inline-fragment').textContent.includes('**第二段**'))
})
