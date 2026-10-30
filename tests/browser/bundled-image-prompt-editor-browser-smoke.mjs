// Real Chromium + React mount of the bundled image prompt editor.
// Run explicitly: node tests/browser/bundled-image-prompt-editor-browser-smoke.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { parse } from 'acorn'
import { chromium } from 'playwright'
import { browserReactScript } from '../fixtures/browser-react.mjs'

const chromePath = [process.env.DSH_BROWSER_EXECUTABLE, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(path => path && existsSync(path)) || chromium.executablePath()
const clientSource = await readFile(new URL('../../tavern-plugin/packages/dsh-tavern-image-bundled/client.js', import.meta.url), 'utf8')

function declaration(name) {
  const ast = parse(clientSource, { ecmaVersion: 'latest', sourceType: 'script' })
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
  if (!found) throw new Error(`Missing bundled client function ${name}`)
  return clientSource.slice(found.start, found.end)
}

const browser = await chromium.launch({ headless: true, executablePath: chromePath })
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(7000)
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.setContent('<!doctype html><div id="root"></div>')
  await page.addScriptTag({ content: await browserReactScript() })

  const promptText = [
    '<scene_composition>two people in a garden</scene_composition>',
    '<character_1><prompt>first character</prompt><uc>bad face</uc></character_1>',
    '<character_2><prompt>second character</prompt><uc>extra fingers</uc></character_2>',
  ].join('\n')
  const componentScript = [
    'const React=modules.react; const useEffect=React.useEffect, useState=React.useState;',
    'const BASE="http://localhost/plugins/dsh-tavern-image"; let openPromptEditor=null; const IMAGE_REFERENCE_PROTOCOLS=new Set(["openai","gemini","gemini-chat","atlascloud","seedream","grok","qwen","sdwebui"]); function uiSupportsImageReferences(channel,state){ if(!channel)return state?.referenceSupported===true; if(channel.provider==="comfyui")return state?.referenceSupported===true&&state?.config?.imageBackend==="comfyui"; return IMAGE_REFERENCE_PROTOCOLS.has(channel.provider==="custom"?String(channel.options?.apiProtocol||"openai"):channel.provider); }',
    'const mediaPostLocks=new Set(), mediaUncertainActions=new Set(), requests=[]; window.__jobOverrides={};',
    'const validMediaContext=context=>Boolean(context&&context.gameId&&context.mediaId&&context.jobId&&context.textVersion&&Number.isFinite(Number(context.turn)));',
    `async function jsonFetch(url,options={}) {
      if(url.includes('/job-detail?')) return {ok:true,job:{rawPrompt:'two people in a garden',tag:'two people in a garden',prompt:'expanded',promptText:${JSON.stringify(promptText)},negative:'base uc'}};
      if(url.includes('/jobs?')) return {ok:true,job:{generationMode:'text',backend:'atlascloud',channelId:'atlas',references:[],positive:'expanded',negative:'base uc',submittedPrompt:'expanded',...(window.__jobOverrides[new URL(url).searchParams.get('id')]||{})}};
      if(url.endsWith('/state')) return {config:{imageChannels:[{id:'atlas',name:'atlas cloud',provider:'atlascloud'},{id:'other',name:'other provider',provider:'novelai'}]}};
      if(url.endsWith('/media-action')) { requests.push(JSON.parse(options.body)); return {ok:true,jobId:'replacement'}; }
      if(url.endsWith('/redraw')) { requests.push(JSON.parse(options.body)); return {ok:true,job:{id:'legacy-replacement'}}; }
      if(url.endsWith('/improve-prompt')) return {ok:true,prompt:'后台改写后的提示词'};
      throw new Error('unexpected request');
    }`,
    'function reportHost(){}; const redrawnJobs=new Map(); function persistRedraw(){}; const lastSessionId="game";',
    declaration('openEditorFor'),
    declaration('PromptEditor'),
    'const root=modules["react-dom/client"].createRoot(document.querySelector("#root")); root.render(React.createElement(PromptEditor));',
    'window.__openEditor=(jobId,context)=>openEditorFor(jobId,"title",context); window.__requests=requests;',
  ].join('\n')
  await page.addScriptTag({ content: componentScript })
  await page.evaluate(() => window.__openEditor('job-1', {
    gameId: 'game', turn: 3, textVersion: 'v3', mediaId: 'media-1', jobId: 'job-1',
  }))

  const prompt = page.locator('textarea').first()
  await page.waitForFunction(() => document.querySelector('textarea')?.value.includes('<character_2>'))
  await prompt.fill('<scene_composition>two people in a garden, clear role list</scene_composition>')
  await page.getByRole('button', { name: /用这段重画/ }).click()
  await page.waitForFunction(() => window.__requests.length === 1)

  const request = await page.evaluate(() => window.__requests[0])
  assert.equal(request.operation, 'redraw')
  assert.equal(request.prompt, '<scene_composition>two people in a garden, clear role list</scene_composition>')
  assert.equal(request.generationMode, 'text')
  assert.equal(request.refreshReferences, false)
  await page.evaluate(() => {
    window.__jobOverrides['job-reference'] = {
      generationMode: 'reference', submittedPrompt: '人物：林月，参照图片1\n环境：窗边', error: 'fixture platform warning',
      references: [{ image: { id: 'a'.repeat(64), name: 'face.png' }, kind: 'character', characterId: 'person-a', index: 1, label: '林月', consistencyText: '保持脸型' }],
    }
    window.__openEditor('job-reference', { gameId: 'game', turn: 3, textVersion: 'v3', mediaId: 'media-reference', jobId: 'job-reference' })
  })
  await page.waitForFunction(() => document.querySelector('[aria-label="本次生图模式"]')?.value === 'reference' && !document.querySelector('[aria-label="本次生图模式"]').disabled)
  assert.equal(await page.getByLabel('使用最新人物库参考图快照').isChecked(), false, 'old reference snapshot is the default')
  const editableBeforeInspection = await prompt.inputValue()
  await page.getByRole('button', { name: /看展开结果/ }).click()
  assert.equal(await page.getByLabel('实际提交提示词', { exact: true }).textContent(), '人物：林月，参照图片1\n环境：窗边')
  assert.equal(await prompt.inputValue(), editableBeforeInspection, 'inspecting actual inputs must not replace editable raw prompt')
  assert.ok((await page.getByRole('img', { name: '参考图 1 林月' }).getAttribute('src')).endsWith('/reference-image?id=' + 'a'.repeat(64)))
  assert.match(await page.getByLabel('原任务参考图').textContent(), /保持脸型/)
  assert.match(await page.getByLabel('平台错误').textContent(), /fixture platform warning/)
  await page.getByLabel('使用最新人物库参考图快照').check()
  await page.getByRole('button', { name: /用这段重画/ }).click()
  await page.waitForFunction(() => window.__requests.length === 2)
  assert.deepEqual(await page.evaluate(() => ({ generationMode: window.__requests[1].generationMode, refreshReferences: window.__requests[1].refreshReferences })), { generationMode: 'reference', refreshReferences: true })

  await page.evaluate(() => window.__openEditor('job-reference', { gameId: 'game', turn: 3, textVersion: 'v3', mediaId: 'media-other', jobId: 'job-reference' }))
  await page.waitForFunction(() => document.querySelector('[aria-label="本次生图模式"]')?.value === 'reference' && !document.querySelector('[aria-label="本次生图模式"]').disabled)
  await page.getByLabel('本次生图渠道').selectOption('other')
  assert.equal(await page.getByRole('button', { name: /用这段重画/ }).isDisabled(), true, 'reference mode cannot silently use another provider')
  assert.match(await page.locator('[role="alert"]').first().textContent(), /当前渠道不支持参考图输入/)
  await page.getByLabel('本次生图模式').selectOption('text')
  await page.getByRole('button', { name: /用这段重画/ }).click()
  await page.waitForFunction(() => window.__requests.length === 3)
  assert.equal(await page.evaluate(() => window.__requests[2].channelId), 'other')
  assert.equal(await page.evaluate(() => window.__requests[2].generationMode), 'text')
  assert.equal(await page.evaluate(() => window.__requests[2].refreshReferences), false)

  await page.evaluate(() => window.__openEditor('job-legacy', null))
  await page.waitForFunction(() => document.querySelector('[aria-label="本次生图模式"]') && !document.querySelector('[aria-label="本次生图模式"]').disabled)
  await page.getByRole('button', { name: /让后台改/ }).click()
  await page.waitForFunction(() => document.querySelector('textarea')?.value === '后台改写后的提示词')
  await page.getByRole('button', { name: /用这段重画/ }).click()
  await page.waitForFunction(() => window.__requests.length === 4)
  assert.equal(await page.evaluate(() => window.__requests[3].prompt), '后台改写后的提示词')
  assert.equal(await page.evaluate(() => window.__requests[3].generationMode), 'text')
  assert.equal(await page.evaluate(() => window.__requests[3].refreshReferences), false)
  assert.deepEqual(pageErrors, [], 'browser runtime reports no uncaught errors')
  console.log('PASS Chromium bundled React prompt editor: role-preserving redraw, immutable input details, reference snapshot opt-in, capability warning, legacy improve/redraw')
} finally {
  await browser.close()
}
