import test from 'node:test'
import assert from 'node:assert/strict'
import { compileChannelJob, compileJob, expandRosterCalls, injectDefinitions } from '../tavern-plugin/packages/dsh-tavern-image-bundled/lib/index.js'
import { imagePluginFixture, imageJson, IMAGE_PNG } from './fixtures/image-plugin-runtime.mjs'

const original = { name: '我的规则', entries: [{ comment: '旧条目', content: 'old unique rule', enabled: true }] }

test('结构化格式保留中文自由衣着与未知人物宏，中文名字不因英文别名而漏掉文字资料', () => {
  const defs = { characters: [{ id: 'lin', name: '林月', match: 'Lin Yue', traits: { face: '银发，深绿色眼睛' }, outfits: [] }],
    settings: [{ id: 'room', name: '房间', match: 'room', layout: '[保留窗格]\n第二行, 第三段' }] }
  const macro = '${"name":"林月","outfit":"红色长裙","angle":"侧面"}$'
  const expanded = expandRosterCalls(macro, defs, 'sfw', { style: 'structured' })
  assert.match(expanded, /人物“林月”：.*红色长裙.*侧面/)
  assert.doesNotMatch(expanded, /is a character|is wearing/)
  const unknown = expandRosterCalls('${"name":"旅人","outfit":"蓝色外套","angle":"背面"}$', defs, 'sfw', { style: 'structured' })
  assert.match(unknown, /旅人.*蓝色外套.*背面/)
  const out = injectDefinitions('【人物】\n林月\n\n【环境】\n房间', defs, { injectWeight: 1.5 }, { style: 'structured' })
  assert.match(out.text, /银发，深绿色眼睛/)
  assert.match(out.text, /\[保留窗格\]\n第二行, 第三段/)
  assert.doesNotMatch(out.text, /:1\.5\)/)
  const twice = injectDefinitions(expanded, defs, {}, { style: 'structured', raw: macro })
  assert.equal((twice.text.match(/银发/g) || []).length, 1)
})

test('四种格式世界书独立读写；当前自动格式按工作流判定，旧文件不覆盖', async t => {
  const fixture = await imagePluginFixture(t, { files: { 'worldbook.json': original, 'worldbook-outfits.json': { name: '衣服', entries: [] } } })
  const runtime = await fixture.start()
  for (const format of ['tags', 'natural', 'mixed']) {
    const read = await runtime.request('worldbook?format=' + format)
    assert.equal(read.status, 200)
    assert.equal(read.body.worldbookFormat, format)
    assert.equal(read.body.worldbookBooks[0].entries[0].content, 'old unique rule')
  }
  const updated = await runtime.request('worldbook-entry', { format: 'tags', book: 'main', index: 0, patch: { content: 'tags-only' } })
  assert.equal(updated.body.ok, true)
  assert.equal((await runtime.request('worldbook?format=tags')).body.worldbook.entries[0].content, 'tags-only')
  assert.equal((await runtime.request('worldbook?format=natural')).body.worldbook.entries[0].content, 'old unique rule')
  const structured = await runtime.request('worldbook?format=structured')
  assert.ok(structured.body.worldbook.entries.some(e => /中文/.test(e.content)))
  assert.equal(structured.body.worldbook.entries.some(e => e.content === 'old unique rule'), false)
  assert.deepEqual(await fixture.read('worldbook.json'), original)
  assert.equal((await runtime.request('worldbook?format=../../escape')).status, 400)
  assert.equal((await runtime.request('worldbook-entry', { format: 'auto', index: 0, patch: { content: 'invalid' } })).status, 400)
  const exported = await runtime.request('worldbook-export?format=tags&book=main')
  assert.equal(exported.body.worldbook.entries[0].content, 'tags-only')
  const state = await runtime.request('config', { promptMode: 'structured' })
  assert.equal(state.body.state.config.promptEffectiveFormat, 'structured')
  assert.equal(state.body.state.worldbookFormat, 'structured')
  const backup = await runtime.request('export-all', {})
  assert.equal(backup.body.bundle.data.formatWorldbooks.tags.main.entries[0].content, 'tags-only')
  assert.equal(backup.body.bundle.data.formatWorldbooks.natural.main.entries[0].content, 'old unique rule')
})

test('旧 Atlas 有效协议 ID 仍可保存，自定义 NAI 只匹配 NAI 与 custom 规则', async t => {
  const fixture = await imagePluginFixture(t, { files: {
    'worldbook.json': { name: 'legacy Atlas rule', entries: [{ comment: 'legacy', content: 'keep this rule', enabled: true, backends: ['atlascloud'] }] },
  }, config: {
    imageBackend: 'custom', activeImageChannel: 'custom-image',
    imageChannels: [{ id: 'custom-image', provider: 'custom', name: 'NAI relay', baseUrl: 'https://nai.example.test', model: 'nai-diffusion-5-full', options: { apiProtocol: 'novelai' } }],
  } })
  const runtime = await fixture.start()
  const saved = await runtime.request('worldbook-entry', { format: 'tags', book: 'main', index: 0, patch: { backends: ['atlascloud', 'custom', 'novelai'] } })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.deepEqual((await runtime.request('worldbook?format=tags')).body.worldbook.entries[0].backends, ['atlascloud', 'custom', 'novelai'])
})

test('结构化编译保留中文多行、标识和括号，补充画风/预设/正负词不变成标签串', () => {
  const text = '【人物】\n角色[c1]林月，站在窗边。\n\n【动作】\n抬手，[不要改变身份]。'
  const config = { imageBackend: 'atlascloud', promptMode: 'structured', activePromptPreset: 'story-cinematic', promptManualPositive: '保留书架细节', promptManualNegative: '不要水印', styleNegative: '不要模糊' }
  const output = compileChannelJob({ config, definitions: { characters: [] }, params: { tag: text, artist: '水彩画', negative: '不要多余人物', size: '1024x1024' }, channel: { provider: 'atlascloud' } })
  assert.ok(output.positive.includes(text))
  assert.match(output.positive, /水彩画/)
  assert.match(output.positive, /保留书架细节/)
  assert.match(output.negative, /不要水印/)
  assert.match(output.negative, /不要模糊/)
  assert.equal(output.promptMode, 'structured')
  const workflow = { id: 'wf', prompt: { '1': { inputs: { text: 'old' } }, '2': { inputs: { text: '工作流负向' } } }, bindings: { positive: [{ node: '1', input: 'text' }], negative: [{ node: '2', input: 'text' }] } }
  const comfy = compileJob({ workflow, config: { ...config, imageBackend: 'comfyui', negativeMode: 'merge' }, params: { tag: text }, definitions: {} })
  assert.ok(comfy.positive.includes(text))
  assert.match(comfy.negative, /工作流负向/)
  assert.equal(comfy.prompt['1'].inputs.text, comfy.positive)
})

test('实际结构化生图请求使用中文约束，改词接口保留多行', async t => {
  const fixture = await imagePluginFixture(t, { config: { promptMode: 'structured', promptManualNegative: '不加水印' },
    llm: { async *stream() { yield { type: 'text-delta', text: '【人物】\n林月\n\n【环境】\n雨夜' } } } })
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    if (init.method === 'POST') return imageJson({ data: { id: 'test-output', status: 'completed', outputs: ['https://images.example.test/a.png'] } })
    return new Response(IMAGE_PNG)
  }
  const runtime = await fixture.start()
  const result = await runtime.request('jobs', { tag: '【人物】\n林月\n\n【动作】\n回头' })
  assert.equal(result.status, 200)
  assert.equal((await runtime.terminal(result.body.id)).state, 'done')
  const payload = JSON.parse(calls.find(call => call.init.method === 'POST').init.body)
  assert.match(payload.prompt, /【人物】\n林月\n\n【动作】\n回头/)
  assert.match(payload.prompt, /不加水印/)
  assert.doesNotMatch(payload.prompt, /Avoid:/)
  const revised = await runtime.request('improve-prompt', { prompt: '【人物】\n林月', instruction: '雨夜' })
  assert.equal(revised.body.prompt, '【人物】\n林月\n\n【环境】\n雨夜')
})
