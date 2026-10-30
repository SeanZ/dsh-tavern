// Real Chromium + React mount of the gallery of plugin pictures.
// Run explicitly: node tests/browser/scene-image-delegation-browser-smoke.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse } from 'acorn'
import { chromium } from 'playwright'
import { browserReactScript } from '../fixtures/browser-react.mjs'

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const features = new URL('../../tavern-plugin/src/client/features/', import.meta.url)
const gallerySource = await readFile(new URL('scene-images.js', features), 'utf8')

function declaration(source, name) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' })
  let found
  function visit(node) {
    if (!node || found) return
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) { found = node; return }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value)
    }
  }
  visit(ast)
  if (!found) throw new Error(`Missing source function ${name}`)
  return source.slice(found.start, found.end)
}

const browser = await chromium.launch({ headless: true, executablePath: chromePath })
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(5000)
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.route('**/api/dsh-tavern/**', route => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="#789"/></svg>'
  }))
  await page.setContent('<!doctype html><meta charset="utf-8"><main><div id="gallery"></div></main>')
  await page.addScriptTag({ content: await browserReactScript() })
  const componentScript = [
    'const React=modules.react;',
    declaration(gallerySource, 'SceneImageGallery'),
    `
      const galleryRoot=modules['react-dom/client'].createRoot(document.querySelector('#gallery'));
      const pending=[], calls=[];
      window.__rpc=(method,args,sessionId)=>{
        if(method==='listSceneImageHistory') return new Promise(resolve=>pending.push({sessionId:sessionId||args.sessionId,resolve}));
        calls.push({method,args,sessionId});
        if(method==='removeSceneImageHistory') return Promise.resolve({results:(args.pluginItems||[]).map(id=>({versionId:id,ok:true}))});
        return Promise.resolve({});
      };
      function rpc(method,args,sessionId){return window.__rpc(method,args,sessionId);}
      function useTavernConfirm(){return async()=>true;}
      const tavernPluginMediaIndex={subscribe:()=>()=>{}};
      const openSceneImagePreview=()=>{};
      const DshUi={IconTrashOutlineRegular:'trash-icon'};
      const sceneImageStageLabel=()=>'';
      const sceneImageRequestId=()=> 'unused';
      const sceneImagePurchaseConfirmation=async()=>undefined;
      const recordImageInteraction=()=>{};
      const SceneImagePending='pending';
      window.__pending=pending; window.__calls=calls;
      window.__setGallerySession=sessionId=>galleryRoot.render(React.createElement(SceneImageGallery,{gallerySessionId:sessionId}));
      window.__setGallerySession('A');
    `
  ].join('\n')
  await page.addScriptTag({ content: componentScript })

  await page.waitForFunction(() => window.__pending.some(request => request.sessionId === 'A'))
  await page.evaluate(() => window.__setGallerySession('B'))
  await page.waitForFunction(() => window.__pending.some(request => request.sessionId === 'B'))
  await page.evaluate(() => {
    const request = window.__pending.find(item => item.sessionId === 'B')
    request.resolve({
      items: [],
      pluginItems: [{ id: 'plugin-B', turn: 1, caption: 'delegated plugin image', createdAt: 2, updatedAt: 3 }]
    })
  })
  await page.locator('#gallery img').first().waitFor()
  await page.evaluate(() => {
    window.__pending.find(item => item.sessionId === 'A').resolve({
      items: [],
      pluginItems: [{ id: 'plugin-A', turn: 1, caption: 'A plugin image', createdAt: 2 }]
    })
  })
  await page.waitForTimeout(50)

  const gallerySources = await page.locator('#gallery img').evaluateAll(images => images.map(image => image.getAttribute('src')))
  assert.equal(gallerySources.length, 1, 'gallery renders the plugin picture')
  assert.ok(gallerySources.some(src => src.includes('plugin-B')))
  assert.ok(gallerySources.every(src => !src.includes('A-')), 'late response from A cannot replace B')

  const pluginFigure = page.locator('#gallery figure[title="delegated plugin image"]')
  await pluginFigure.getByRole('button', { name: '删除这张图片' }).click()
  await page.waitForFunction(() => window.__calls.some(call => call.method === 'removeSceneImageHistory'))
  const deletion = await page.evaluate(() => window.__calls.find(call => call.method === 'removeSceneImageHistory'))
  assert.equal(deletion.sessionId, 'B')
  assert.equal(deletion.args.sessionId, 'B')
  assert.deepEqual(Array.from(deletion.args.pluginItems), ['plugin-B'])
  assert.equal(deletion.args.items, undefined, 'only plugin pictures are left to delete')
  assert.deepEqual(pageErrors, [], 'browser runtime reports no uncaught errors')
  console.log('PASS Chromium gallery smoke: plugin pictures, session isolation, scoped deletion, no page errors')
} finally {
  await browser.close()
}
