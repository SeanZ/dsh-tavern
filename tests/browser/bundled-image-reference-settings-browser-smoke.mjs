// Mount the complete bundled client in real React; all plugin HTTP is stubbed.
// node tests/browser/bundled-image-reference-settings-browser-smoke.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright'
import { browserReactScript } from '../fixtures/browser-react.mjs'

const executablePath = [process.env.DSH_BROWSER_EXECUTABLE, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(path => path && existsSync(path))
const clientSource = await readFile(new URL('../../tavern-plugin/packages/dsh-tavern-image-bundled/client.js', import.meta.url), 'utf8')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jdbsAAAAASUVORK5CYII=', 'base64')
const clone = value => JSON.parse(JSON.stringify(value))
const calls = [], errors = []
let uploads = 0
const books = format => [{ key: 'main', name: format + '规则', count: 1, entries: [{ index: 0, comment: format + '条目', content: format + ' content', enabled: true, activation: 'always' }] }, { key: 'outfits', name: format + '服装规则', count: 0, entries: [] }]
const worldbooks = Object.fromEntries(['tags', 'natural', 'mixed', 'structured'].map(format => [format, books(format)]))
const state = {
  config: { imageEnabled: true, imageBackend: 'atlascloud', generationMode: 'text', promptMode: 'tags', promptEffectiveFormat: 'tags', activeImageChannel: 'atlas',
    imageChannels: [{ id: 'atlas', provider: 'atlascloud', name: 'atlas cloud', model: 'keep-exact-model', options: {} }], stylePresets: [], promptPresets: [] },
  definitions: { characters: [{ id: 'person-a', name: '林月', match: 'Lin Yue', cards: [], traits: { face: 'keep original traits' }, outfits: [{ id: 'outfit-a', name: '白衬衫', upper: 'white shirt', enabled: true }] }], scenes: [], props: [] },
  outfits: [{ id: 'shared-a', name: '通用外套', upper: 'coat', enabled: true }],
  worldbookFormat: 'tags', worldbookBooks: clone(worldbooks.tags), tasks: [], workflows: [], imageProviders: [{ id: 'atlascloud', label: 'atlas cloud' }],
}
const browser = await chromium.launch({ headless: true, executablePath })
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(8000)
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), path = url.pathname.replace('/plugins/dsh-tavern-image', ''), method = route.request().method()
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' })
    if (path === '/reference-image' && method === 'GET') return route.fulfill({ contentType: 'image/png', body: png })
    const body = method === 'POST' ? route.request().postDataJSON() : null
    calls.push({ path, method, query: Object.fromEntries(url.searchParams), body })
    let response = { ok: true }
    if (path === '/state') response = clone(state)
    else if (path === '/config') { Object.assign(state.config, body.config); response = { ok: true, state: clone(state) } }
    else if (path === '/reference-image') { uploads++; response.referenceImage = { id: uploads.toString(16).repeat(64), name: body.name, mediaType: body.mediaType, byteLength: png.length } }
    else if (path === '/definitions') { state.definitions = clone(body.definitions); state.outfits = clone(body.definitions.outfits || []); response = { ok: true, state: clone(state) } }
    else if (path === '/worldbook') { const format = url.searchParams.get('format'); assert.ok(worldbooks[format]); response = { ok: true, worldbookFormat: format, worldbook: { name: format, entries: clone(worldbooks[format].flatMap(book => book.entries)) }, worldbookBooks: clone(worldbooks[format]) } }
    else if (path === '/worldbook-entry') { const book = worldbooks[body.format]?.find(book => book.key === body.book); assert.ok(book); Object.assign(book.entries[body.index], body.patch) }
    else if (path === '/history') response = { ok: true, jobs: [] }
    else if (path === '/tasks') response = { tasks: [] }
    else if (path === '/cards') response = { ok: true, cards: [] }
    else if (path === '/providers' || path === '/llm-models') response = { ok: true, providers: [], models: [] }
    else if (path === '/report') response = { ok: true }
    else { errors.push('unexpected HTTP ' + method + ' ' + path); response = { ok: false, error: 'unexpected request' } }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) })
  })
  await page.goto('http://reference-ui.test/')
  await page.addScriptTag({ content: await browserReactScript() })
  await page.addScriptTag({ content: 'window.__ModuleLoader__={load(spec){window.__plugin=spec.factory(name=>modules[name])}};' })
  await page.addScriptTag({ content: clientSource })
  await page.evaluate(() => {
    let Settings
    window.__plugin.apply({ slots: { inject(_name, install) { return install() }, register(spec, component) { if (spec.name === 'settings.section') Settings = component; return () => {} } }, inject() {} })
    if (!Settings) throw new Error('SettingsPanel not registered')
    const root = modules['react-dom/client'].createRoot(document.querySelector('#root'))
    root.render(modules.react.createElement(Settings))
  })
  await page.getByLabel('默认生图模式').selectOption('reference')
  await page.waitForFunction(() => document.querySelector('[aria-label="默认生图模式"]')?.value === 'reference')
  await page.getByLabel('提示词格式', { exact: true }).selectOption('structured')
  await page.waitForFunction(() => document.querySelector('[aria-label="提示词格式"]')?.value === 'structured')
  assert.equal(state.config.generationMode, 'reference')
  assert.equal(state.config.promptMode, 'structured')
  assert.equal(state.config.imageChannels[0].model, 'keep-exact-model')
  assert.ok(calls.filter(call => call.path === '/config').every(call => !Object.hasOwn(call.body.config, 'imageChannels')), 'mode switches never alter model/channel configuration')

  await page.getByRole('button', { name: '人物库', exact: true }).click()
  const saveLibrary = async label => {
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/definitions') && response.request().method() === 'POST'), page.getByRole('button', { name: label, exact: true }).click()])
    await page.getByText('人物库已保存', { exact: false }).first().waitFor()
  }
  const upload = async (label, name) => {
    await page.getByLabel(label, { exact: true }).setInputFiles({ name, mimeType: 'image/png', buffer: png })
    const section = page.getByLabel(label.replace('上传参考图', '参考图设置'), { exact: true })
    await section.getByRole('img').waitFor()
  }
  await upload('角色「林月」上传参考图', 'person.png')
  await page.getByLabel('角色「林月」一致性补充', { exact: true }).fill('保持脸型，动作由正文决定')
  await upload('服装「白衬衫」上传参考图', 'shirt.png')
  await page.getByLabel('服装「白衬衫」一致性补充', { exact: true }).fill('保持领口设计')
  assert.equal(state.definitions.characters[0].referenceImage, undefined, 'uploads remain drafts until library save')
  await saveLibrary('保存人物库')
  assert.equal(state.definitions.characters[0].referenceImage.name, 'person.png')
  assert.equal(state.definitions.characters[0].outfits[0].referenceImage.name, 'shirt.png')
  assert.equal(state.definitions.characters[0].consistencyText, '保持脸型，动作由正文决定')
  assert.equal(state.definitions.characters[0].outfits[0].consistencyText, '保持领口设计')
  assert.equal(state.definitions.characters[0].traits.face, 'keep original traits')

  await upload('通用服装「通用外套」上传参考图', 'coat.png')
  await page.getByLabel('通用服装「通用外套」一致性补充', { exact: true }).fill('保持袖口')
  await saveLibrary('保存服装库')
  assert.equal(state.outfits[0].referenceImage.name, 'coat.png')
  assert.equal(state.outfits[0].consistencyText, '保持袖口')
  await page.getByLabel('角色「林月」移除参考图', { exact: true }).click()
  await saveLibrary('保存人物库')
  assert.equal(state.definitions.characters[0].referenceImage, null)
  assert.equal(state.definitions.characters[0].consistencyText, '保持脸型，动作由正文决定')
  assert.equal(calls.some(call => call.method === 'DELETE'), false)

  await page.getByRole('button', { name: '世界书', exact: true }).click()
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await page.getByPlaceholder('条目内容（作为画图规则发给模型）').fill('tags pending draft')
  await page.getByLabel('世界书格式', { exact: true }).selectOption('structured')
  await page.getByText('1. structured条目', { exact: true }).waitFor()
  assert.equal(worldbooks.tags[0].entries[0].content, 'tags pending draft')
  assert.equal(worldbooks.structured[0].entries[0].content, 'structured content')
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await page.getByPlaceholder('条目内容（作为画图规则发给模型）').fill('中文结构化规则')
  await page.getByLabel('世界书格式', { exact: true }).selectOption('natural')
  await page.getByText('1. natural条目', { exact: true }).waitFor()
  assert.equal(worldbooks.structured[0].entries[0].content, '中文结构化规则')
  assert.equal(worldbooks.natural[0].entries[0].content, 'natural content')
  assert.equal(state.config.promptMode, 'structured', 'browsing worldbooks does not switch the active prompt format')
  assert.deepEqual(errors, [])
  console.log('PASS Chromium full settings: generation modes, structured format, character/nested/shared reference drafts and saving, local-only unlink, worldbook format isolation')
} finally { await browser.close() }
