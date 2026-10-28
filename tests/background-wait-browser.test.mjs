import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {chromium} from 'playwright'
import { sourceFunction } from './fixtures/source-function.mjs'
const require=createRequire(import.meta.url)
test('long-wait notice shows a working stop button in Chromium',async()=>{
 let script='const modules={};\n'
 for(const [name,file] of [['react','react.production.js'],['scheduler','scheduler.production.js'],['react-dom','react-dom.production.js'],['react-dom/client','react-dom-client.production.js']]) {
  script+=`modules[${JSON.stringify(name)}]=(()=>{const module={exports:{}};const exports=module.exports;const require=name=>modules[name];\n${await readFile(join(dirname(require.resolve(name)),'cjs',file),'utf8')}\nreturn module.exports;})();\n`
 }
 const source=await readFile(new URL('../tavern-plugin/lib/client.js',import.meta.url),'utf8')
 const stop=sourceFunction(source, 'TavernStopBackgroundAction')
 const wait=await readFile(new URL('../tavern-plugin/src/client/modules/background-wait.js',import.meta.url),'utf8')
 script+=`const React=modules.react;window.calls=[];const activity={busy:true,phase:'running',operationId:'op-1',updatedAt:Date.now()-90000};
 const useTavernCoordination=()=>({view:{activity}});const liveTavernView={invalidate(){}};const tavernCoordination={invalidate(){}};const tavernErrorHub={report(){throw Error('unexpected error')}};
 async function rpc(method,args,sessionId){window.calls.push({method,args,sessionId});return {progress:{phase:'model',startedAt:Date.now()-90000,lastProgressAt:Date.now()-90000}}}
 ${wait}\n${stop}\nmodules['react-dom/client'].createRoot(document.querySelector('main')).render(React.createElement(TavernBackgroundWait,{sessionId:'game',activity}));`
 const browser=await chromium.launch({headless:true})
 try {
  const page=await browser.newPage();page.on('pageerror', error => { throw error });await page.setContent('<main></main>');await page.addScriptTag({content:script})
  await page.getByText(/正在等待模型 API/).waitFor()
  await page.getByRole('button',{name:'停止后台',exact:true}).click()
  const calls=await page.evaluate(()=>window.calls)
  assert.deepEqual(calls.find(call=>call.method==='stopBackground'),{method:'stopBackground',args:{operationId:'op-1'},sessionId:'game'})
 } finally {await browser.close()}
})
test('后台任务页在 Chromium 中分开显示进行中与最近完成',async()=>{
 let script='const modules={};\n'
 for(const [name,file] of [['react','react.production.js'],['scheduler','scheduler.production.js'],['react-dom','react-dom.production.js'],['react-dom/client','react-dom-client.production.js']]) {
  script+=`modules[${JSON.stringify(name)}]=(()=>{const module={exports:{}};const exports=module.exports;const require=name=>modules[name];\n${await readFile(join(dirname(require.resolve(name)),'cjs',file),'utf8')}\nreturn module.exports;})();\n`
 }
 const wait=await readFile(new URL('../tavern-plugin/src/client/modules/background-wait.js',import.meta.url),'utf8')
 script+=`const React=modules.react;const t=Date.now();
 function TavernStopBackgroundAction(){return React.createElement('button',null,'停止后台')}
 async function rpc(method){return {runs:[
  {id:'run-3',task:'plugin',plugin:'地图',lane:'ephemeral',turn:5,model:'m',status:'failed',queuedAt:t-9000,startedAt:t-9000,endedAt:t-4000,error:'信号读取失败'},
  {id:'run-2',task:'candidate',lane:'resident',turn:5,model:'m',status:'queued',queuedAt:t-2000},
  {id:'run-1',task:'settlement',lane:'resident',turn:5,model:'m',status:'running',queuedAt:t-8000,startedAt:t-8000}]}}
 ${wait}\nmodules['react-dom/client'].createRoot(document.querySelector('main')).render(React.createElement(TavernBackgroundTasksTab,{sessionId:'game'}));`
 const browser=await chromium.launch({headless:true})
 try {
  const page=await browser.newPage();page.on('pageerror', error => { throw error });await page.setContent('<main></main>');await page.addScriptTag({content:script})
  await page.getByText('运行 1 · 排队 1 · 失败 1').waitFor()
  const [active, done]=await page.locator('section').allInnerTexts()
  assert.match(active, /进行中[\s\S]*生成选项[\s\S]*排队中[\s\S]*第 5 轮 · 常驻[\s\S]*变量结算[\s\S]*运行中[\s\S]*停止后台/)
  assert.match(done, /最近完成[\s\S]*插件「地图」[\s\S]*失败[\s\S]*信号读取失败/)
 } finally {await browser.close()}
})
