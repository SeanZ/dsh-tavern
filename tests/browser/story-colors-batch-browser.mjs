import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { helperClient } from '../fixtures/helper-host-harness.mjs'

const browser = await chromium.launch({ headless:true, executablePath:process.env.CHROMIUM_EXECUTABLE })
try {
  const page = await browser.newPage({viewport:{width:1200,height:900}})
  await page.setContent('<style>:root{color:#222}main{height:600px;overflow:auto}article{height:100px}</style><main></main>')
  await page.evaluate(({install,quotes}) => {
    const create = new Function('return ('+install+')')(), find = new Function('return ('+quotes+')')()
    window.trace=[]; window.handles=[]
    const read=window.getComputedStyle, add=Highlight.prototype.add
    window.getComputedStyle=function(...args){window.trace.push('read');return read.apply(this,args)}
    Highlight.prototype.add=function(...args){window.trace.push('write');return add.apply(this,args)}
    for(let i=0;i<80;i++) {
      const host=document.createElement('article');document.querySelector('main').appendChild(host)
      const shadow=host.attachShadow({mode:'open'}), content=document.createElement('div')
      content.innerHTML='<p>楼层 '+i+' “对白” <em>心想</em><span style="color:red">“作者红色”</span></p>'
      shadow.appendChild(content);window.handles.push(create(content,{},find))
    }
    window.count=()=>[...CSS.highlights.values()].reduce((n,h)=>n+h.size,0)
  },{install:helperClient.installTavernTextColors.toString(),quotes:helperClient.findTavernQuoteRanges.toString()})
  await page.waitForFunction(()=>window.count()>0)
  await page.waitForTimeout(100)
  const mounted=await page.evaluate(()=>({ranges:window.count(),styles:[...document.querySelectorAll('article')].filter(x=>x.shadowRoot.querySelector('style[data-dsh-tavern-text-colors]')).length,highlights:CSS.highlights.size}))
  assert.equal(mounted.styles,80)
  assert.equal(mounted.highlights,4)
  assert.ok(mounted.ranges<160,'离屏楼层初次挂载不扫描')
  await page.evaluate(()=>{window.trace=[];for(const host of document.querySelectorAll('article'))host.shadowRoot.querySelector('p').firstChild.data+=' 更新'})
  await page.waitForTimeout(150)
  const batch=await page.evaluate(()=>({reads:trace.filter(x=>x==='read').length,writes:trace.filter(x=>x==='write').length,interleaved:trace.slice(trace.indexOf('write')).includes('read')}))
  assert.ok(batch.reads>0 && batch.writes>0)
  assert.equal(batch.interleaved,false,'同文档的可见楼层全部读取完成后才更新 Highlight')
  await page.evaluate(()=>{window.trace=[];document.querySelector('article:last-child').shadowRoot.querySelector('p').firstChild.data+=' 末楼变化'})
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(()=>trace.length),0,'离屏变更只标记脏，不读取样式或更新区间')
  await page.evaluate(()=>document.querySelector('main').scrollTop=10000)
  await page.waitForTimeout(180)
  assert.ok(await page.evaluate(()=>[...CSS.highlights.values()].some(h=>[...h].some(r=>r.startContainer.getRootNode()===document.querySelector('article:last-child').shadowRoot))))
  await page.evaluate(()=>{handles.at(-1).setColors({quote:'#123456',em:'#654321'})})
  assert.match(await page.locator('article:last-child').evaluate(e=>e.shadowRoot.querySelector('style').textContent),/#123456/)
  assert.equal(await page.evaluate(()=>[...CSS.highlights.values()].some(h=>[...h].some(r=>r.toString().includes('作者红色')))),false)
  await page.evaluate(()=>handles.at(-1).dispose())
  assert.ok(await page.evaluate(()=>window.count()>0),'释放单楼不影响其它楼层')
  await page.evaluate(()=>handles.forEach(h=>h.dispose()))
  assert.equal(await page.evaluate(()=>CSS.highlights.size),0)
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('article')].some(e=>e.shadowRoot.querySelector('style[data-dsh-tavern-text-colors]'))),false)
  console.log(JSON.stringify({mounted,batch,passed:true}))
} finally {await browser.close()}
