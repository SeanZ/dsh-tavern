import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

const source = fileURLToPath(new URL('../tavern-plugin/packages/dsh-tavern-image-bundled/', import.meta.url))
const SECRET = 'sk-SUPERSECRET-123456'
const DEFINITIONS = { characters: [
  { id: 'm', name: '阿梅', match: 'A Mei', enabled: true, traits: { face: 'black long hair, dark brown eyes', negative: 'glasses, beard, short hair' }, outfits: [{ id: 'o1', name: '常服', upper: 'cream cardigan', lower: 'blue skirt', full: 'cream cardigan over a blue skirt', negative: 'jeans' }] },
  { id: 'mf', name: '阿梅（狐形）', match: 'A Mei fox form', enabled: true, traits: { face: 'silver-white long hair, pale ice-blue eyes, white fox ears' }, outfits: [] },
] }
const story = '雨夜，阿梅和他共撑一把伞。' + SECRET
const PLANNER_TEXT = '<image><regex>阿梅和他共撑一把伞</regex><title>雨夜</title><prompts>${"name":"A Mei","outfit":"常服"}$, A Mei and a man with short black hair share an umbrella in the rain</prompts></image>'

async function runtime(t, { diagnostics, definitions = DEFINITIONS, plannerText = PLANNER_TEXT, setup, text = story } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-comfy-test-'))
  await mkdir(join(root, 'lib')); await mkdir(join(root, 'workflows'))
  await cp(join(source, 'lib'), join(root, 'lib'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(join(root, 'worldbook.json'), JSON.stringify({ name: 'test', entries: [] }))
  await writeFile(join(root, 'definitions.json'), JSON.stringify(definitions))
  if (diagnostics !== undefined) {
    if (diagnostics === 'broken') { await writeFile(join(root, 'diagnostics.json'), JSON.stringify({ enabled: true })); await writeFile(join(root, 'diagnostics'), 'not a dir') }
    else await writeFile(join(root, 'diagnostics.json'), JSON.stringify(diagnostics))
  }
  await writeFile(join(root, 'workflows', 'test.json'), JSON.stringify({
    format: 'dsh-tavern-comfy-v1', outputNode: '9',
    prompt: { '1': { class_type: 'CLIPTextEncode', _meta: { title: '正向提示词' }, inputs: { text: '' } }, '2': { class_type: 'CLIPTextEncode', _meta: { title: '负面提示词' }, inputs: { text: 'lowres' } }, '9': { class_type: 'SaveImage', inputs: { images: ['1', 0] } } },
    bindings: { positive: [{ node: '1', input: 'text' }], negative: [{ node: '2', input: 'text' }] },
  }))
  if (setup) await setup(root)
  const routes = new Map(), disposes = [], bodies = [], llmCalls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(input)
    if (url.pathname === '/prompt') { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ prompt_id: 'comfy-' + bodies.length }), { status: 200 }) }
    return new Response(JSON.stringify({ queue_running: [], queue_pending: [] }), { status: 200 })
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    llm: { stream: args => { llmCalls.push(structuredClone({ ...args, signal: undefined })); return (async function* () { yield { type: 'text-delta', text: plannerText } })() } },
    webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path) } },
    inject(names, install) { if (names.every(name => this[name])) install(this) },
    effect(install) { const off = install(); if (typeof off === 'function') disposes.push(off); return off },
  }
  const { apply } = await import(pathToFileURL(join(root, 'lib', 'index.js')).href + '?' + Math.random())
  apply(ctx, { plannerProvider: 'mock', plannerModel: 'mock', plannerCount: 1, comfyAuthToken: SECRET, negativeMode: 'plugin', promptMode: 'tags', injectWeight: 1 })
  t.after(async () => {
    for (const dispose of disposes.splice(0).reverse()) dispose()
    globalThis.fetch = originalFetch
    await delay(40)
    assert.ok(resolve(root).startsWith(resolve(tmpdir())) && basename(root).startsWith('dsh-comfy-test-'))
    await rm(root, { recursive: true, force: true })
  })
  const request = (path, body) => new Promise((ok, fail) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    Object.assign(req, { method: 'POST', url: '/plugins/dsh-tavern-image/' + path, headers: { host: 'localhost', 'content-type': 'application/json' } })
    routes.get(req.url)(req, { headersSent: false, writeHead(s) { this.status = s }, end(b) { try { ok({ status: this.status, body: JSON.parse(String(b)) }) } catch (e) { fail(e) } } })
  })
  const plan = () => request('plan', { text, messageId: 'm1', sessionId: 'game-1', count: 1, manual: true })
  const events = async () => {
    const dir = join(root, 'diagnostics')
    try { if (!(await stat(dir)).isDirectory()) return [] } catch { return [] }
    const out = []
    for (const id of await readdir(dir)) out.push(...(await readFile(join(dir, id, 'events.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l)))
    return out
  }
  return { root, plan, bodies, llmCalls, events }
}


test('开着诊断时规划照常出图，并记录宏展开结果（以前引用不存在的变量，每张图都提交失败）', async t => {
  const f = await runtime(t, { diagnostics: { enabled: true, contentMode: 'full' } })
  const r = await f.plan(); await delay(30)
  assert.equal(r.status, 200)
  assert.equal(f.bodies.length, 1, 'image reaches ComfyUI')
  const ev = await f.events()
  const macro = ev.find(e => e.stage === 'macro-expansion')
  assert.match(JSON.stringify(macro.data.expanded), /cream cardigan/)
})

test('规划调用了人物库里没有的角色时在结果里说明；服装宏和库里对得上的人不算', async t => {
  const definitions = { characters: [
    { id: 'y', name: '宋玉轩', match: 'Song Yuxuan', enabled: true, cards: ['cards/另一张卡.json'], traits: { face: 'long black hair' }, outfits: [] },
  ] }
  const plannerText = '<image><regex>阿梅和他共撑一把伞</regex><title>雨夜</title><prompts>1girl, solo, ${"name":"Song Yuxuan", "angle":"from front", "upperBody":"sfw"}$, ${"name":"Lu Qi", "angle":"from front", "upperBody":"sfw"}$, ${"name":"红裙", "upperBody":"visible"}$, umbrella, rain</prompts></image>'
  const f = await runtime(t, { definitions, plannerText })
  const r = await f.plan()
  assert.equal(r.status, 200)
  const warnings = r.body.characterWarnings ?? r.body.plan?.characterWarnings
  assert.ok(Array.isArray(warnings), JSON.stringify(Object.keys(r.body)))
  assert.equal(warnings.length, 1, warnings.join(' / '))
  assert.match(warnings[0], /「Lu Qi」不在人物库里/)
})

test('cache 兜底补回的历史图不落盘，不再挤掉带 key 的真实作业记录', async t => {
  const realId = '00000000-0000-4000-8000-000000000001'
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)])
  const old = new Date('2026-01-01T00:00:00Z')
  const f = await runtime(t, { setup: async root => {
    const { utimes } = await import('node:fs/promises')
    await mkdir(join(root, 'cache'))
    await writeFile(join(root, 'cache', realId + '.img'), png)
    // 上一版留下的占位记录：无 key、无提示词、createdAt 是某次启动时间
    const placeholderId = '00000000-0000-4000-8000-0000000000ff'
    await writeFile(join(root, 'cache', placeholderId + '.img'), png)
    await utimes(join(root, 'cache', placeholderId + '.img'), old, old)
    await writeFile(join(root, 'jobs-store.json'), JSON.stringify({
      [realId]: { id: realId, state: 'done', createdAt: Date.parse('2026-06-01T00:00:00Z'), key: 'game-1:3:abc', positive: '1girl, solo', label: 'agent 规划', file: join(root, 'cache', realId + '.img') },
      [placeholderId]: { id: placeholderId, state: 'done', createdAt: Date.now(), label: '历史图片', params: {} },
    }))
    for (let i = 0; i < 200; i++) {
      const id = '00000000-0000-4000-8000-1' + String(i).padStart(11, '0')
      await writeFile(join(root, 'cache', id + '.img'), png)
      await utimes(join(root, 'cache', id + '.img'), old, old)
    }
  } })
  await delay(150)
  const r = await f.plan(); await delay(80)
  assert.equal(r.status, 200)
  const saved = JSON.parse(await readFile(join(f.root, 'jobs-store.json'), 'utf8'))
  const list = Object.values(saved)
  assert.ok(saved[realId], '真实作业记录还在')
  assert.equal(saved[realId].key, 'game-1:3:abc')
  assert.equal(list.filter(job => job.label === '历史图片').length, 0, '占位记录不落盘')
  assert.ok(list.length <= 150)
})

test('挂载句只差 Markdown 记号或换行时照样出图（以前逐字比对，整张图静默不画）', async t => {
  const f = await runtime(t, { text: '雨夜，**阿梅**和他\r\n共撑一把伞。' })
  const r = await f.plan(); await delay(30)
  assert.equal(r.status, 200)
  assert.equal(f.bodies.length, 1)
  assert.equal(r.body.characterWarnings, undefined)
})

test('人物宏点名的衣服，负面词也进负向通道（以前只补人物自己的负面词）', async t => {
  const f = await runtime(t)
  await f.plan(); await delay(30)
  const negative = f.bodies[0].prompt['2'].inputs.text
  assert.match(negative, /jeans/)
  assert.match(negative, /glasses/)
})
