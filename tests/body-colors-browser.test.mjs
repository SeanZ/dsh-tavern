// 真实 React 与 Chromium Highlight API：父级草稿更新不得清空正文配色。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
test('草稿逐字更新保留引号高亮，正文变化同步刷新范围且卸载释放', { skip: !process.env.TAVERN_BROWSER_TESTS }, async () => {
  const { chromium } = require('playwright'), esbuild = require('esbuild')
  const root = path.resolve('tavern-plugin')
  const source = (await Promise.all(['text-colors.js', 'body-markdown.js'].map(file => readFile(path.join(root, 'src/client', file), 'utf8')))).join('\n')
  const contents = `import * as React from ${JSON.stringify(require.resolve('react'))};
import * as ReactDOM from ${JSON.stringify(require.resolve('react-dom'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {renderBodyMarkdown} from ${JSON.stringify(path.join(root,'lib/domain/body-renderer.js'))};
import bodyDom from ${JSON.stringify(path.join(root,'lib/domain/body-dom.cjs'))};
const {sanitizeTavernBodyHtml}=bodyDom, DshUi={}, bindTavernFontZoom=()=>()=>{};
${source}
const h=React.createElement, app=createRoot(document.querySelector('main'));
window.quoteText='他说：“测试对话”。';
function App(){const [draft,setDraft]=React.useState('');return h(React.Fragment,null,
h('input',{value:draft,onChange:e=>ReactDOM.flushSync(()=>setDraft(e.target.value))}),
h(TavernBodyMarkdown,{prepared:{text:window.quoteText,slots:[]},static:window.staticBody}));}
window.show=()=>ReactDOM.flushSync(()=>app.render(h(App)));
window.ranges=()=>[...CSS.highlights.values()].flatMap(value=>[...value]).map(range=>range.toString());
window.unmount=()=>ReactDOM.flushSync(()=>app.unmount());window.show();`
  const bundle = await esbuild.build({stdin:{contents,resolveDir:process.cwd()},bundle:true,format:'iife',write:false,define:{'process.env.NODE_ENV':'"production"'},logLevel:'warning'})
  const browser = await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE ? {executablePath:process.env.CHROMIUM_EXECUTABLE} : {})})
  try {
    for (const staticBody of [false,true]) {
      const page = await browser.newPage(), errors=[]
      page.on('pageerror',e=>errors.push(e.message))
      await page.setContent('<style>body{--dsw-alias-brand-primary:rgb(255,0,0)}</style><main></main>')
      await page.evaluate(value=>{window.staticBody=value},staticBody)
      await page.addScriptTag({content:bundle.outputFiles[0].text})
      await page.waitForFunction(()=>window.ranges().includes('“测试对话”'))
      await page.evaluate(()=>{window.palette=[...CSS.highlights.keys()];window.frames=[];document.querySelector('input').addEventListener('input',()=>requestAnimationFrame(()=>window.frames.push(window.ranges())))})
      await page.locator('input').pressSequentially('typing',{delay:50})
      const state=await page.evaluate(()=>({frames:window.frames,ranges:window.ranges(),same:JSON.stringify(window.palette)===JSON.stringify([...CSS.highlights.keys()])}))
      assert.ok(state.frames.length>=5)
      assert.ok(state.frames.every(ranges=>ranges.includes('“测试对话”')),JSON.stringify(state))
      assert.equal(state.same,true,'仅草稿变化不得卸载配色实例')
      const changed=await page.evaluate(()=>{window.quoteText='他说：“修改后的对话”。';window.show();return window.ranges()})
      assert.ok(changed.includes('“修改后的对话”'))
      await page.evaluate(()=>window.unmount())
      assert.equal(await page.evaluate(()=>CSS.highlights.size),0)
      assert.deepEqual(errors,[])
      await page.close()
    }
  } finally { await browser.close() }
})
