// 真 Chromium + 宿主已构建 MarkdownText；不启动模型、不访问用户会话。
// TAVERN_BROWSER_TESTS=1、DSH_MARKDOWN_PACKAGE、ESBUILD_MODULE 指定现有依赖；不自动安装。
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {createRequire} from 'node:module'
import path from 'node:path'
import {projectReplyLayers,projectReplyHistory} from '../tavern-plugin/lib/domain/reply-presentation.js'

const prose='第一段。\n\n**第二段**\n\n- 第一点\n- 第二点\n\n> 引用内容'
const simple='<details>\n<summary>隐藏剧情</summary>\n'+prose+'\n</details>'
const nested='<details><summary>外层</summary><details><summary>内层</summary>**保留原样**</details></details>'
const encoded='<details><summary>标签示例</summary>&lt;details&gt;&lt;summary&gt;内层&lt;/summary&gt;**不重入**&lt;/details&gt;</details>'
const cases={simple,nested,encoded,html:'<details><summary>已有排版</summary><p>第一段<br>第二行</p><table><tr><td>单元格</td></tr></table></details>',
 styled:'<details style="color:red"><summary>作者样式</summary>**保留原样**</details>',
 adjacent:'<details><summary>记录</summary><!-- 不展示 --></details>'+simple}

test('新局身份与故事折叠 Markdown：真实宿主组件、HTML/Chat 边界、快照与重复挂载', {skip:!process.env.TAVERN_BROWSER_TESTS},async()=>{
  assert(process.env.DSH_MARKDOWN_PACKAGE,'需要宿主 Markdown 包路径')
  assert(process.env.ESBUILD_MODULE,'需要已有 esbuild 模块路径')
  const require=createRequire(import.meta.url)
  const hostRequire=createRequire(path.join(path.resolve(process.env.DSH_MARKDOWN_PACKAGE),'package.json'))
  const esbuild=require(process.env.ESBUILD_MODULE),{chromium}=require('playwright')
  const dir=await mkdtemp(path.join(tmpdir(),'story-details-browser-'))
  let browser
  try{
    const bundle=await esbuild.build({stdin:{contents:`import * as React from ${JSON.stringify(hostRequire.resolve('react'))};
import {createRoot} from ${JSON.stringify(hostRequire.resolve('react-dom/client'))};
import {MarkdownText} from ${JSON.stringify(path.resolve(process.env.DSH_MARKDOWN_PACKAGE,'lib/index.js'))};
window.fixture={React,createRoot,MarkdownText};
window.__ModuleLoader__={load(d){window.client=d.factory(name=>name==='react'?React:name==='@deepseek-ai/dsh-client-ui-primitives'?{MarkdownText}:{});}};`,resolveDir:process.cwd()},
      bundle:true,format:'iife',outfile:path.join(dir,'deps.js'),write:false,
      alias:{react:path.dirname(hostRequire.resolve('react')),'react-dom':path.dirname(hostRequire.resolve('react-dom/package.json'))},
      define:{'process.env.NODE_ENV':'"production"'},loader:{'.module.css':'local-css','.woff':'dataurl','.woff2':'dataurl','.ttf':'dataurl'},logLevel:'warning'})
    browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})})
    const page=await browser.newPage(),errors=[]
    page.setDefaultTimeout(10000)
    page.on('pageerror',e=>errors.push(e.message))
    const client=await readFile(new URL('../tavern-plugin/lib/client.js',import.meta.url),'utf8')
    const projections=Object.fromEntries(Object.entries(cases).map(([key,text])=>[key,projectReplyLayers(text)]))
    for(const width of [1200,390]){
      await page.setViewportSize({width,height:900})
      await page.setContent('<style>body{font:16px/1.8 system-ui;margin:20px}main{max-width:700px;margin:auto}section{margin-bottom:20px}p{margin:16px 0}</style><main><h1>故事折叠块 Markdown 验证</h1><section id="outer"></section><section id="story"></section><section id="chat"></section></main>')
      for(const out of bundle.outputFiles){
        if(out.path.endsWith('.css'))await page.addStyleTag({content:out.text})
        else if(out.path.endsWith('.js'))await page.addScriptTag({content:out.text})
      }
      await page.addScriptTag({content:client})
      // 新局只有开场白：Chat 走宿主正文，故事视图消费持久化模板的公共投影。
      const source='欢迎 <user>，请选择路线。'
      const opening={role:'assistant',greeting:true,turn:1,sourceText:source,
        text:'欢迎 林舟，请选择路线。',projectionText:'欢迎 林舟，请选择路线。',
        tavernPluginData:{template_display:{source,swipe:0,formattingText:source+'\n\n<div>状态：平静</div>',html:'<p>'+source+'</p><div>状态：平静</div>'}}}
      const projectedOpening=projectReplyHistory([opening],{macroState:{userName:'林舟'}}).projections
      await page.evaluate(({opening,projectedOpening})=>{
        const {React,createRoot,MarkdownText}=window.fixture,h=React.createElement
        const render=client.createTavernStoryRender({})
        client.liveTavernView.setView('opening',{mode:'story',replyProjections:projectedOpening,tavernRuntimePolicy:{trustedCardMode:true}})
        window.openingRoots=[createRoot(document.querySelector('#story')),createRoot(document.querySelector('#chat'))]
        openingRoots[0].render(h(render.FloorBody,{sessionId:'opening',storyTurn:1,fallbackText:opening.text}))
        openingRoots[1].render(h(MarkdownText,{text:opening.text}))
      },{opening,projectedOpening})
      await page.locator('#story .dsh-tavern-colored-markdown').waitFor()
      assert.equal((await page.locator('#story .dsh-tavern-colored-markdown').innerText()).trim(),opening.text)
      assert.equal((await page.locator('#chat').innerText()).trim(),opening.text)
      assert.equal(await page.locator('#story user').count(),0)
      assert.equal(await page.locator('#story iframe').count(),0)
      await page.evaluate(()=>openingRoots.forEach(root=>root.unmount()))
      await page.evaluate(({projections,prose})=>{
        const {React,createRoot,MarkdownText}=window.fixture,h=React.createElement
        const render=client.createTavernStoryRender({})
        window.roots={story:createRoot(document.querySelector('#story')),chat:createRoot(document.querySelector('#chat'))}
        createRoot(document.querySelector('#outer')).render(h(MarkdownText,{text:prose}))
        window.show=(key,snapshot)=>{
          client.liveTavernView.setView('test',{mode:'story',replyProjections:[{turn:2,version:2,parts:projections[key].displayParts}],tavernRuntimePolicy:{trustedCardMode:true}})
          roots.story.render(h(render.FloorBody,{sessionId:'test',storyTurn:2,...(snapshot?{snapshotHtml:snapshot}:{})}))
          roots.chat.render(h(React.Fragment,null,client.renderTavernProjection({parts:projections[key].displayParts},{sessionId:'chat',turn:2,trustedCardMode:true})))
        }
        window.projectedBefore=JSON.stringify(projections)
        window.projections=projections
        window.show('simple')
      },{projections,prose})
      await page.locator('#story details > summary').waitFor()
      assert.equal(await page.locator('#story details').getAttribute('open'),null)
      await page.locator('#story summary').click()
      assert.equal(await page.locator('#story strong').textContent(),'第二段')
      assert.equal(await page.locator('#story li').count(),2)
      assert.equal((await page.locator('#story blockquote').textContent()).trim(),'引用内容')
      const markup=await page.locator('#story .dsh-tavern-colored-markdown > div').innerHTML()
      assert.equal(markup,await page.locator('#outer > div').innerHTML(),'内外复用同一 Markdown 输出')
      assert.equal(await page.locator('#chat strong').count(),0,'Chat HTML 不启用故事适配')
      const snapshot=await page.locator('#story details').evaluate(el=>el.outerHTML)
      await page.evaluate(snapshot=>show('simple',snapshot),snapshot)
      await page.locator('#story .dsh-tavern-floor-static').waitFor()
      assert.equal(await page.locator('#story strong').count(),1,'HTML 快照不重复包装')
      for(const key of ['html','styled','nested']){
        await page.evaluate(key=>show(key),key)
        await page.locator('#story .dsh-tavern-floor-static').waitFor()
        assert.equal(await page.locator('#story .dsh-tavern-colored-markdown').count(),0,key)
      }
      await page.evaluate(()=>show('encoded'))
      await page.locator('#story .dsh-tavern-colored-markdown').waitFor({state:'attached'})
      assert.equal(await page.locator('#story details').count(),1,'编码标签不会变成嵌套 details')
      const count=await page.locator('#story *').count()
      for(let n=0;n<12;n++){
        await page.evaluate(()=>show('encoded'))
        assert.equal(await page.locator('#story *').count(),count,'反复渲染不增长')
      }
      await page.evaluate(()=>show('adjacent'))
      await page.locator('#story strong').waitFor({state:'attached'})
      assert.equal(await page.locator('#story .dsh-tavern-colored-markdown').count(),1)
      assert(!await page.locator('#story').textContent().then(text=>text.includes('不展示')))
      assert.equal(await page.evaluate(()=>JSON.stringify(projections)===projectedBefore),true)
      await page.evaluate(()=>show('simple'))
      await page.locator('#story details > summary').click()
      assert.equal(await page.locator('#story details').getAttribute('open'),'')
      await page.locator('#story details > summary').click()
      assert.equal(await page.locator('#story details').getAttribute('open'),null)
      await page.locator('#story details > summary').click()
      if(process.env.TAVERN_E2E_OUTPUT)await page.screenshot({path:path.join(process.env.TAVERN_E2E_OUTPUT,`markdown-${width}.png`),fullPage:true})
    }
    assert.deepEqual(errors,[])
    if(process.env.TAVERN_E2E_OUTPUT)await writeFile(path.join(process.env.TAVERN_E2E_OUTPUT,'markdown-browser.json'),JSON.stringify({status:'passed',widths:[1200,390],pageErrors:errors,markdown:'宿主实际 MarkdownText',scope:'浏览器组件集成；非完整宿主或真实手机'},null,2))
  }finally{await browser?.close();await rm(dir,{recursive:true,force:true})}
})
