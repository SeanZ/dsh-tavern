// 真实 Chromium、React 与宿主 CodeBlock 验证局部槽、增量同步和业务源坐标。
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {createRequire} from 'node:module'
import path from 'node:path'

test('正文媒体 portal、代码与提及交互、列表舞台坐标及流式节点保留', {skip:!process.env.TAVERN_BROWSER_TESTS},async()=>{
 const require=createRequire(import.meta.url),host=require
 const esbuild=require(process.env.ESBUILD_MODULE||'esbuild'),{chromium}=require('playwright')
 const dir=await mkdtemp(path.join(tmpdir(),'body-slots-browser-'))
 const root=path.resolve('tavern-plugin')
 const body=await readFile(path.join(root,'src/client/body-markdown.js'),'utf8')
 const group=await readFile(path.join(root,'src/client/body-group.js'),'utf8')
 const primitives=path.resolve(process.env.DSH_MARKDOWN_PACKAGE,'lib/index.js')
 const contents=`import * as React from ${JSON.stringify(host.resolve('react'))};
import * as ReactDOM from ${JSON.stringify(host.resolve('react-dom'))};
import {createRoot} from ${JSON.stringify(host.resolve('react-dom/client'))};
import * as DshUi from ${JSON.stringify(primitives)};
import {renderBodyMarkdown as convertBodyMarkdown,createBodyRenderPlan} from ${JSON.stringify(path.join(root,'lib/domain/body-renderer.js'))};
import bodyDom from ${JSON.stringify(path.join(root,'lib/domain/body-dom.cjs'))};
import bubbleLine from ${JSON.stringify(path.join(root,'src/client/bubble-line.cjs'))};
import stageEntry from ${JSON.stringify(path.join(root,'packages/dsh-tavern-stage/src/client/chat-entry.cjs'))};
import {segmentPluginText} from ${JSON.stringify(path.join(root,'lib/domain/plugin-text-segments.js'))};
window.bodyConversions=0;
const renderBodyMarkdown=(...args)=>{window.bodyConversions++;return convertBodyMarkdown(...args)};
const {sanitizeTavernBodyHtml}=bodyDom;
const {parseBubbles,bubbleLiteralLines}=bubbleLine;
const galParagraphCount=()=>0;
const installTavernTextColors=()=>({dispose(){}}),findTavernQuoteRanges=()=>[],bindTavernFontZoom=()=>()=>{};
${body}
${group}
const h=React.createElement;
window.events=[];window.mountCount=0;
function Media(){React.useEffect(()=>{window.mountCount++},[]);return h('button',{className:'media',onClick:()=>events.push('media')},'媒体按钮')}
const entry=stageEntry.createStageChatEntry({React,MutationObserver,plain:text=>text,blocks:text=>[text],enter:(session,position)=>events.push({session,...position}),schedule:setTimeout,cancel:clearTimeout});
const app=createRoot(document.querySelector('main'));
window.show=(suffix='')=>{
 const text='<details><summary>记录</summary>\\n**加粗**\\n</details>\\n\\n- 第一项\\n- 第二项\\n\\n正文 MEDIA 尾部\\n\\n\\x60文件.txt\\x60\\n\\n\\x60\\x60\\x60js\\nconst answer = 42\\n\\x60\\x60\\x60'+suffix;
 const parts=[{kind:'markdown',text}];
 const plugin={prepareBody(text){let offset=0;return segmentPluginText(text,{markers:[/MEDIA/g]}).segments.map(segment=>{const start=offset;offset+=segment.kind==='text'?segment.text.length:segment.match[0].length;return segment.kind==='text'?{start,end:offset}:{start,end:offset,node:h(Media),block:true}})}};
 const prepared=prepareTavernBodyGroup(createBodyRenderPlan({parts})[0],parts,{plugin});
 const fileMentions={resolve:text=>text==='文件.txt'?{label:'打开文件',open:()=>events.push('file')}:null};
 app.render(h(TavernBodyMarkdown,{prepared,fileMentions,trustedCardMode:true,renderBusiness:(_mounts,externalRoot)=>externalRoot?h(entry.Markdown,{externalRoot,sourceKey:'source',sessionId:'synthetic',turn:7,sourceUnits:[{para:4,block:'- 第一项\\n- 第二项'}]}):null}));
};
window.show();`
 let browser
 try{
  const bundle=await esbuild.build({stdin:{contents,resolveDir:process.cwd()},bundle:true,format:'iife',outfile:path.join(dir,'bundle.js'),write:false,
   plugins:[{name:'fixture-cjs',setup(build){build.onLoad({filter:/(?:bubble-line|chat-entry)\.cjs$/},async args=>({contents:(await readFile(args.path,'utf8')).replace(/typeof window === ["']undefined["'] && /g,'').replace(/ && typeof window === ["']undefined["']/g,''),loader:'js',resolveDir:path.dirname(args.path)}))}}],
   alias:{react:path.dirname(host.resolve('react')),'react-dom':path.dirname(host.resolve('react-dom/package.json'))},define:{'process.env.NODE_ENV':'"production"'},loader:{'.module.css':'local-css','.woff':'dataurl','.woff2':'dataurl','.ttf':'dataurl'},logLevel:'warning'})
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})})
  const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']});
  const page=await context.newPage(),errors=[]
  await page.route('http://127.0.0.1:54321/**',route=>route.fulfill({contentType:'text/html',body:'<main></main>'}))
  page.on('pageerror',e=>errors.push(e.message))
  for(const width of [1200,390]){
   await page.setViewportSize({width,height:900});await page.goto('http://127.0.0.1:54321/')
   for(const out of bundle.outputFiles){if(out.path.endsWith('.css'))await page.addStyleTag({content:out.text});else await page.addScriptTag({content:out.text})}
   await page.locator('.media').waitFor();await page.locator('li:last-child .fork-stage-enter-here').waitFor()
   await page.locator('summary').click();await page.locator('.media').click();await page.getByRole('button',{name:'打开文件',exact:true}).click()
   await page.locator('li:last-child .fork-stage-enter-here').click()
   assert.equal(await page.locator('details strong').innerText(),'加粗')
   assert.equal(await page.locator('ul > button').count(),0)
   assert.ok(await page.getByText('const answer = 42',{exact:false}).count())
   await page.getByRole('button',{name:'复制',exact:true}).click()
   assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'const answer = 42')
   await page.evaluate(()=>{window.oldMedia=document.querySelector('.media');window.show('\\n\\n追加正文')})
   await page.getByText('追加正文',{exact:false}).waitFor()
   assert.deepEqual(await page.evaluate(()=>({same:oldMedia===document.querySelector('.media'),open:document.querySelector('details').open,mountCount,events})),{same:true,open:true,mountCount:1,events:['media','file',{session:'synthetic',turn:7,para:4}]})
   const conversions=await page.evaluate(()=>window.bodyConversions)
   await page.evaluate(()=>window.show('\\n\\n追加正文'))
   await page.waitForTimeout(100)
   assert.equal(await page.evaluate(()=>window.bodyConversions),conversions,'相同正文重绘不重复转换')
   await page.mouse.wheel(0,500)
   await page.waitForTimeout(100)
   assert.equal(await page.evaluate(()=>window.mountCount),1,'滚动不重挂媒体')
   assert.deepEqual(errors,[])
  }
 }finally{await browser?.close();await rm(dir,{recursive:true,force:true})}
})
