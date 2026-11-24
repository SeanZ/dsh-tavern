import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import vm from './fixtures/client-vm.mjs' // foreground document fixture
import test from 'node:test'
import {chromium,webkit} from 'playwright'
import {readTavernRuntimeAsset} from '../tavern-plugin/lib/domain/tavern-runtime-assets.js'
let descriptor
vm.runInNewContext(await readFile(new URL('../tavern-plugin/lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:d=>descriptor=d}},console})
const client=descriptor.factory(()=>({}))
const pinned='/api/dsh-tavern/remote-assets/'+'a'.repeat(64)+'/mvu_zod.js?host=2'
for(const [name,engine] of Object.entries({chromium,webkit})) test(`${name}: srcdoc 中消息帧与共享脚本沙箱加载实际 Zod/YAML`, { skip: process.platform === 'win32' && name === 'webkit' ? 'Playwright WebKit is not available on Windows test machines' : false }, async t=>{
 const server=createServer(async(req,res)=>{
   res.setHeader('Access-Control-Allow-Origin','*')
   if(req.url===pinned){
     res.setHeader('content-type','text/javascript')
     res.end('export const loaded=true')
     return
   }
   const asset=await readTavernRuntimeAsset(new URL(req.url,'http://localhost').pathname)
   res.setHeader('content-type',asset?.mediaType||'text/html')
   res.end(asset?.body||'<!doctype html><body>测试宿主</body>')
 })
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)))
 const browser=await engine.launch();t.after(()=>browser.close());const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port)
 const context={messages:[{message_id:0,role:'assistant',message:'opening',variables:{}}]}
 const schema = `import { loaded } from "${pinned}";
   const url = "${pinned}";
   window.pinnedLoaded = loaded && (await import(url)).loaded;
   window.schemaResult = z.object({hp:z.number()}).parse({hp:7});
   window.yamlResult = YAML.parse("hp: 7");`
 const documents=[
   client.buildTavernFrameDocument({token:'message',content:'正文<script type="module">window.moduleResult=[YAML.parse("hp: 7").hp,z.number().parse(7)]</script>',helperContext:context}),
   client.buildTavernHelperScriptDocument({token:'shared',context,scripts:[{id:'schema',content:schema}]})
 ]
 for(const sandbox of [false,true]) for(const [index,html] of documents.entries()){
  await page.evaluate(({html,sandbox})=>{
    document.querySelector('iframe')?.remove()
    const frame=document.createElement('iframe')
    if(sandbox) frame.sandbox='allow-scripts'
    frame.srcdoc=html
    document.body.append(frame)
  },{html,sandbox})
  const frame=page.frames().find(f=>f!==page.mainFrame())
  await frame.waitForFunction(()=>window.__dshTavernHelperReady,undefined,{timeout:5000})
  const ready=await frame.evaluate(()=>window.__dshTavernHelperReady.then(()=>({ok:true}),e=>({ok:false,error:e.message})))
  assert.deepEqual(ready,{ok:true})
  // Inline module scripts run after the helper globals load, not racing them.
  if(index===0){await frame.waitForFunction(()=>window.moduleResult,undefined,{timeout:5000});assert.deepEqual(await frame.evaluate(()=>window.moduleResult),[7,7])}
  if(index===1){
    await frame.waitForFunction(()=>window.schemaResult,undefined,{timeout:5000})
    assert.deepEqual(await frame.evaluate(()=>[window.schemaResult.hp,window.yamlResult.hp,window.pinnedLoaded]),[7,7,true])
  }
 }
})
