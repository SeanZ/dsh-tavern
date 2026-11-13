import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
const {createStageChatEntry}=createRequire(import.meta.url)('../tavern-plugin/packages/dsh-tavern-stage/src/client/chat-entry.cjs')
test('chat stage entry releases long-press timers and ignores late clicks on plugin disposal',()=>{
 const effects=[],timers=new Set();let updates=0,entered=0,callback
 const React={createElement:(type,props,...children)=>({type,props,children}),useState:value=>[value,()=>updates++],useRef:value=>({current:value}),useEffect:fn=>effects.push(fn),useLayoutEffect:fn=>effects.push(fn)}
 const entry=createStageChatEntry({React,enter:()=>entered++,schedule:fn=>{callback=fn;timers.add(fn);return fn},cancel:fn=>timers.delete(fn)})
 const paragraph=entry.Paragraph({turn:1,para:2,children:'text'})
 const button=entry.EnterHere({sessionId:'s',turn:1,para:2})
 const stops=effects.map(fn=>fn())
 paragraph.props.onPointerDown({pointerType:'touch'})
 assert.equal(timers.size,1)
 entry.dispose();callback()
 button.props.onClick({preventDefault(){},stopPropagation(){}})
 assert.equal(timers.size,0)
 assert.equal(updates,0)
 assert.equal(entered,0)
 stops.forEach(fn=>fn?.())
})
test('markdown entry disposal restores original DOM marks and cannot be revived by queued observers',async()=>{
 const {JSDOM}=await import('jsdom')
 const dom=new JSDOM('<div id="root"><p class="original" data-fork-stage-turn="old">第一段</p><p>第二段</p></div>')
 const parent=dom.window.document.getElementById('root'),effects=[]
 let ref=0,observerCallback
 const React={createElement:(type,props,...children)=>({type,props,children}),useRef:value=>({current:++ref===1?parent:value}),useLayoutEffect:fn=>effects.push(fn),useEffect:fn=>effects.push(fn)}
 const entry=createStageChatEntry({React,plain:text=>text,blocks:text=>text.split('\n\n'),schedule:()=>1,cancel(){},MutationObserver:class {constructor(fn){observerCallback=fn}observe(){}disconnect(){}}})
 entry.Markdown({text:'第一段\n\n第二段',turn:2,base:0,markdownProps:{}})
 const stops=effects.map(fn=>fn())
 assert.equal(parent.querySelectorAll('button').length,2)
 const first=parent.querySelector('p');first.classList.add('is-long-pressed')
 entry.dispose()
 observerCallback([{type:'characterData',target:first}])
 assert.equal(parent.querySelectorAll('button').length,0)
 assert.equal(first.className,'original')
 assert.equal(first.getAttribute('data-fork-stage-turn'),'old')
 assert.equal(parent.querySelectorAll('[data-fork-stage-para]').length,0)
 stops.forEach(fn=>fn?.());dom.window.close()
})

test('混排列表与表格映射旧源段落，不拆结构且点击保留业务坐标',async()=>{
 const {JSDOM}=await import('jsdom')
 const dom=new JSDOM('<main><ul><li>第一项</li><li>第二项</li></ul><table><tbody><tr><td>名称</td><td>数值</td></tr></tbody></table></main>')
 const parent=dom.window.document.querySelector('main'),effects=[],calls=[]
 const React={createElement(){},useRef:value=>({current:value}),useLayoutEffect:fn=>effects.push(fn),useEffect:fn=>effects.push(fn)}
 const entry=createStageChatEntry({React,plain:text=>text,blocks:text=>[text],enter:(...args)=>calls.push(args),MutationObserver:dom.window.MutationObserver,schedule:setTimeout,cancel:clearTimeout})
 entry.Markdown({externalRoot:parent,sourceKey:'7:0:0',sessionId:'synthetic',turn:7,sourceUnits:[{para:4,block:'- 第一项\n- 第二项'},{para:5,block:'| 名称 | 数值 |'}]})
 const stops=effects.map(fn=>fn())
 assert.equal(parent.querySelectorAll('button').length,2)
 assert.equal(parent.querySelector('ul > button,table > button'),null)
 parent.querySelector('li:last-child button').click();parent.querySelector('td:last-child button').click()
 assert.deepEqual(calls,[['synthetic',{turn:7,para:4}],['synthetic',{turn:7,para:5}]])
 entry.dispose();assert.equal(parent.querySelectorAll('button').length,0)
 stops.forEach(fn=>fn?.());dom.window.close()
})

test('自动分段后的多个显示段只挂一个原源段落入口，媒体缺口不改变编号',async()=>{
 const {JSDOM}=await import('jsdom'),dom=new JSDOM('<main><p>前半句。</p><div data-tavern-story-dynamic>媒体</div><p>后半句。</p></main>')
 const parent=dom.window.document.querySelector('main'),effects=[],calls=[]
 const React={createElement(){},useRef:value=>({current:value}),useLayoutEffect:fn=>effects.push(fn),useEffect:fn=>effects.push(fn)}
 const entry=createStageChatEntry({React,plain:text=>text,blocks:text=>[text],enter:(...args)=>calls.push(args),MutationObserver:dom.window.MutationObserver,schedule:setTimeout,cancel:clearTimeout})
 entry.Markdown({externalRoot:parent,sourceKey:'source',sessionId:'synthetic',turn:7,sourceUnits:[{para:4,block:'前半句。MEDIA后半句。'}]})
 const stops=effects.map(fn=>fn())
 assert.equal(parent.querySelectorAll('button').length,1)
 parent.querySelector('p:last-child button').click()
 assert.deepEqual(calls,[['synthetic',{turn:7,para:4}]])
 entry.dispose();stops.forEach(fn=>fn?.());dom.window.close()
})

test('相邻同文源段落分别定位到各自显示段落',async()=>{
 const {JSDOM}=await import('jsdom'),dom=new JSDOM('<main><p>沉默。</p><p>沉默。</p></main>')
 const parent=dom.window.document.querySelector('main'),effects=[]
 const React={createElement(){},useRef:value=>({current:value}),useLayoutEffect:fn=>effects.push(fn),useEffect:fn=>effects.push(fn)}
 const entry=createStageChatEntry({React,plain:text=>text,blocks:text=>[text],enter(){},MutationObserver:dom.window.MutationObserver,schedule:setTimeout,cancel:clearTimeout})
 entry.Markdown({externalRoot:parent,sourceKey:'source',sessionId:'s',turn:1,sourceUnits:[{para:1,block:'沉默。'},{para:2,block:'沉默。'}]})
 const stops=effects.map(fn=>fn())
 assert.deepEqual([...parent.querySelectorAll('p')].map(p=>p.querySelector('button')?.getAttribute('data-fork-stage-para')),['1','2'])
 entry.dispose();stops.forEach(fn=>fn?.());dom.window.close()
})
