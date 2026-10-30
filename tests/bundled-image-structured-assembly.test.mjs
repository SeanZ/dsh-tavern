import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStructuredReferenceText, referenceScopedDefinitions, resolveImageReferences } from '../tavern-plugin/packages/dsh-tavern-image-bundled/lib/reference-images.js'
import { compileChannelJob, compileJob, expandRosterCalls } from '../tavern-plugin/packages/dsh-tavern-image-bundled/lib/index.js'
import { imagePluginFixture, imageJson, IMAGE_PNG } from './fixtures/image-plugin-runtime.mjs'

test('默认规则升级接口预览并按指纹更新，陈旧预览不覆盖编辑', async t => {
  const fixture = await imagePluginFixture(t)
  const runtime = await fixture.start()
  const before = await runtime.request('worldbook-upgrade?book=main')
  assert.equal(before.status, 200)
  const entry = before.body.upgrade.entries[0]
  await runtime.request('worldbook-entry', { format: 'structured', book: 'main', index: 0, patch: { content: '用户自定义规则' } })
  const stale = await runtime.request('worldbook-upgrade', { book: 'main', expectedFingerprint: before.body.upgrade.fingerprint, entryIds: [entry.id] })
  assert.equal(stale.status, 409)
  const preview = await runtime.request('worldbook-upgrade?book=main')
  assert.equal(preview.body.upgrade.entries[0].state, 'customized')
  const updated = await runtime.request('worldbook-upgrade', { book: 'main', expectedFingerprint: preview.body.upgrade.fingerprint, entryIds: [entry.id] })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.upgrade.entries[0].state, 'current')
  assert.ok(updated.body.upgrade.backupFile)
  assert.equal((await runtime.request('worldbook-upgrade?book=invalid')).status, 400)
})

const image = { id: 'a'.repeat(64), mediaType: 'image/png', byteLength: IMAGE_PNG.length, name: '身份.png' }
const defs = { characters: [{ id: 'jiang', name: '江铭', traits: { face: '旧外貌不应注入' }, referenceImage: image, outfits: [] }], outfits: [] }

test('结构化绑定按实际类型生成，不输出ID，不改用户的一致性补充', () => {
  const selected = resolveImageReferences({ subjects: [{ characterId: 'jiang' }], definitions: defs })
  selected.references[0].consistencyText = '保留[眉间痣]。\n不要改变黑发。'
  const text = buildStructuredReferenceText(selected.references)
  assert.match(text, /参考图1 → 江铭/)
  assert.match(text, /固有体型比例/)
  assert.doesNotMatch(text, /服装图|characterId|outfitId/)
  assert.ok(text.includes(selected.references[0].consistencyText))
  assert.equal(buildStructuredReferenceText([]), '')
  assert.throws(() => buildStructuredReferenceText([{ ...selected.references[0], index: 2 }]))
})

test('旧快照占位标记经结构化编译清除，但保留姓名、无图人物资料和自定义分节', () => {
  const library = structuredClone(defs)
  library.characters.push({ id: 'chen', name: '陈安', traits: { face: '黑发，白衬衫' }, outfits: [] })
  const selected = resolveImageReferences({ subjects: [{ characterId: 'jiang' }, { characterId: 'chen' }], definitions: library })
  const legacy = referenceScopedDefinitions(library, selected.references, { subjects: selected.subjects })
  assert.match(legacy.characters[0].traits.face, /characterId/)
  const scoped = referenceScopedDefinitions(legacy, selected.references, { subjects: selected.subjects, markers: false })
  const source = '【自定义场面】\n${"name":"江铭"}$和陈安各拿一把伞。\n\n【用户约束】\n保留[文字]和 (记号:1.2)。'
  const expanded = expandRosterCalls(source, scoped, 'sfw', { style: 'structured' })
  assert.match(expanded, /江铭和陈安/)
  const output = compileChannelJob({ params: { tag: expanded, rawTag: source, referenceText: buildStructuredReferenceText(selected.references) }, definitions: scoped,
    config: { promptMode: 'structured', imageBackend: 'atlascloud' }, channel: { provider: 'atlascloud' } })
  assert.doesNotMatch(output.positive, /characterId|身份参照图|旧外貌|人物“江铭”：/)
  assert.match(output.positive, /黑发，白衬衫/)
  assert.ok(output.positive.includes('保留[文字]和 (记号:1.2)。'))
  assert.equal((output.positive.match(/参考图1 →/g) || []).length, 1)
  assert.match(legacy.characters[0].traits.face, /characterId/, 'old snapshot is immutable')
})

test('同名人物宏、服装归属与绑定使用同一短称呼；同图不同对象不合并', () => {
  const library = { characters: ['a', 'b'].map(id => ({ id, name: '江铭', referenceImage: image, outfits: [{ id: 'o', name: '常服', referenceImage: image }] })) }
  const selected = resolveImageReferences({ subjects: ['a', 'b'].map(characterId => ({ characterId, outfitId: 'o' })), definitions: library })
  assert.equal(selected.references.length, 4)
  const scoped = referenceScopedDefinitions(library, selected.references, { subjects: selected.subjects, markers: false })
  const expanded = expandRosterCalls('${"name":"a","angle":"左侧"}$\n${"name":"b","angle":"右侧"}$', scoped, 'sfw', { style: 'structured' })
  assert.match(expanded, /人物“江铭（对象1）”：左侧/)
  assert.match(expanded, /人物“江铭（对象3）”：右侧/)
  const bindings = buildStructuredReferenceText(selected.references)
  assert.match(bindings, /参考图2 → 江铭（对象1）／常服/)
  assert.match(bindings, /参考图4 → 江铭（对象3）／常服/)
  assert.doesNotMatch(bindings, /characterId|outfitId/)
  const onlyOutfits = selected.references.filter(r => r.kind === 'outfit').map((r, index) => ({ ...r, index: index + 1 }))
  assert.doesNotMatch(buildStructuredReferenceText(onlyOutfits), /身份图/)
})

test('结构化Comfy编译保留组装来源', () => {
  const output = compileJob({ workflow: { id: 'wf', prompt: { '1': { inputs: { text: '' } } }, bindings: { positive: [{ node: '1', input: 'text' }] } },
    config: { promptMode: 'structured', imageBackend: 'comfyui' }, params: { tag: '【人物】\n陈安' }, definitions: { characters: [{ name: '陈安', traits: { face: '黑发' } }] } })
  assert.equal(output.promptAssembly.version, 2)
  assert.match(output.promptAssembly.definitionAdditions.join('\n'), /黑发/)
})

test('真实任务组装一次绑定；改词重画、重启仍使用快照，不累积说明', async t => {
  const calls = []
  const fixture = await imagePluginFixture(t, { config: { generationMode: 'reference', promptMode: 'structured' } })
  globalThis.fetch = async (url, init = {}) => {
    if (url.endsWith('/uploadMedia')) return imageJson({ data: { download_url: 'https://images.example.test/ref.png' } })
    if (url.endsWith('/generateImage')) { calls.push(JSON.parse(init.body)); return imageJson({ data: { id: 'img-' + calls.length, status: 'completed', outputs: ['https://images.example.test/out.png'] } }) }
    return new Response(IMAGE_PNG)
  }
  const runtime = await fixture.start()
  const upload = await runtime.request('reference-image', { data: IMAGE_PNG.toString('base64'), mediaType: 'image/png' })
  const library = structuredClone(defs)
  library.characters[0].referenceImage = upload.body.referenceImage
  await runtime.request('definitions', { definitions: library })
  const raw = '人物\n江铭，一名年轻男子。\n\n动作\n一手撑住床沿，侧转回望。'
  const start = await runtime.request('jobs', { tag: raw, subjects: [{ characterId: 'jiang' }] })
  assert.equal(start.status, 200)
  const original = await runtime.terminal(start.body.id)
  assert.equal(original.state, 'done')
  const detail = (await runtime.request('job-detail?id=' + original.id)).body.job
  assert.equal(detail.rawPrompt, raw)
  assert.equal(detail.promptAssembly.version, 2)
  assert.deepEqual(detail.promptAssembly.definitionAdditions, [])
  assert.equal(detail.rawPromptSource, 'rawTag')
  const restarted = await fixture.start()
  const redraw = await restarted.request('redraw', { jobId: original.id, prompt: raw + '\n神情警觉。' })
  assert.equal(redraw.status, 200)
  assert.equal((await restarted.terminal(redraw.body.jobId)).state, 'done')
  assert.equal(calls.length, 2)
  for (const payload of calls) {
    assert.equal((payload.prompt.match(/参考图1 →/g) || []).length, 1)
    assert.doesNotMatch(payload.prompt, /characterId|outfitId|人物“江铭”：|服装图/)
  }
})
