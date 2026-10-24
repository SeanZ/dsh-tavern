import test from 'node:test'
import assert from 'node:assert/strict'
import { compileChannelJob, compileJob, injectDefinitions } from '../tavern-plugin/packages/dsh-tavern-image-bundled/lib/index.js'

const channel = { id: 'test', provider: 'novelai', baseUrl: 'https://image.test', model: 'nai-diffusion-4-5-full', apiKey: 'test', options: {} }
const config = { imageBackend: 'novelai', promptMode: 'tags', traitMode: 'default', weightMode: 'auto', negativeMode: 'plugin', sizes: {} }

const alice = {
  id: 'alice', name: 'Alice', match: 'Alice', enabled: true,
  traits: { face: 'long hair', negative: 'hair bun, double bun' }, outfits: [],
}

function compile(params, definitions = { characters: [] }) {
  return compileChannelJob({ params, config, definitions, channel })
}

test('角色负面压同一角色的正面，并保留人物库负面注入', () => {
  const out = compile({
    tag: '1girl, indoors', rawTag: '1girl, indoors',
    characters: [{ prompt: 'Alice, double bun, long hair, standing', centers: 'C3', uc: 'background characters' }],
  }, { characters: [alice] })

  assert.equal(out.characters.length, 1)
  assert.doesNotMatch(out.characters[0].prompt, /double bun/)
  assert.match(out.characters[0].prompt, /long hair/)
  assert.match(out.characters[0].uc, /hair bun/)
  assert.match(out.characters[0].uc, /double bun/)
})

test('带权重的角色负面按组保留，只从正面删同 tag', () => {
  const out = compile({
    tag: '1girl, indoors', rawTag: '1girl, indoors',
    characters: [{
      prompt: 'Alice, double bun, jade hairpin, long hair',
      centers: 'C3',
      uc: 'background characters, 2::hair bun, double bun::',
    }],
  })

  assert.doesNotMatch(out.characters[0].prompt, /double bun/)
  assert.match(out.characters[0].prompt, /jade hairpin/)
  assert.match(out.characters[0].uc, /2::hair bun, double bun::/)
})

test('角色负面只影响该角色，不影响其他角色的正面', () => {
  const out = compile({
    tag: '1girl, 1boy, indoors', rawTag: '1girl, 1boy, indoors',
    characters: [
      { prompt: 'Alice, blush, long hair', centers: 'C3', uc: 'blush' },
      { prompt: 'Bob, blush, short hair', centers: 'D4', uc: '' },
    ],
  })

  assert.doesNotMatch(out.characters[0].prompt, /blush/)
  assert.match(out.characters[1].prompt, /blush/)
})

test('keepNegative 让正面已有的 tag 仍能进入角色负面，供去重使用', () => {
  const raw = 'Alice, double bun, long hair'
  const filtered = injectDefinitions(raw, { characters: [alice] }, {}, { raw })
  assert.doesNotMatch(filtered.negatives.join(', '), /double bun/)
  const kept = injectDefinitions(raw, { characters: [alice] }, {}, { raw, keepNegative: true })
  assert.match(kept.negatives.join(', '), /double bun/)
})

test('人物库里的带权重负面注入后仍能压掉正面同 tag', () => {
  const weightedAlice = { ...alice, traits: { ...alice.traits, negative: '2:: hair bun, double bun ::' } }
  const out = compile({
    tag: '1girl, indoors', rawTag: '1girl, indoors',
    characters: [{ prompt: 'Alice, double bun, jade hairpin, long hair', centers: 'C3', uc: 'background characters' }],
  }, { characters: [weightedAlice] })

  assert.doesNotMatch(out.characters[0].prompt, /double bun/)
  assert.match(out.characters[0].prompt, /jade hairpin/)
  assert.match(out.characters[0].uc, /hair bun/)
  assert.match(out.characters[0].uc, /double bun/)
})

test('非 NovelAI 渠道保持旧的平铺逻辑，不做角色负面优先去重', () => {
  const params = {
    tag: '1girl, indoors', rawTag: '1girl, indoors',
    characters: [{ prompt: 'Alice, double bun, long hair, standing', centers: 'C3', uc: 'background characters' }],
  }
  for (const backend of ['openai', 'gemini']) {
    const out = compileChannelJob({ params, config, definitions: { characters: [alice] }, channel: { id: backend, provider: backend, options: {} } })
    assert.deepEqual(out.characters, [])
    assert.match(out.positive, /double bun/)
    assert.match(out.negative, /hair bun/)
    assert.doesNotMatch(out.negative, /double bun/)
  }
  const chat = compileChannelJob({ params, config, definitions: { characters: [alice] }, channel: { id: 'nai-chat', provider: 'novelai', options: { protocol: 'chat' } } })
  assert.deepEqual(chat.characters, [])
  assert.match(chat.positive, /double bun/)
  assert.doesNotMatch(chat.negative, /double bun/)
})

test('ComfyUI 工作流保持旧的平铺逻辑，不做角色负面优先去重', () => {
  const workflow = {
    prompt: { positive: { inputs: { text: '' } }, negative: { inputs: { text: '' } } },
    bindings: { positive: [{ node: 'positive', input: 'text' }], negative: [{ node: 'negative', input: 'text' }] },
    sizes: {},
  }
  const params = {
    tag: '1girl, indoors', rawTag: '1girl, indoors',
    characters: [{ prompt: 'Alice, double bun, long hair', centers: 'C3', uc: 'background characters' }],
  }
  const compiled = compileJob({
    workflow, params,
    config: { ...config, imageBackend: 'comfyui', weightMode: 'keep', negativeMode: 'merge' },
    definitions: { characters: [alice] },
  })
  assert.match(compiled.prompt.positive.inputs.text, /double bun/)
  assert.match(compiled.prompt.negative.inputs.text, /hair bun/)
  assert.doesNotMatch(compiled.prompt.negative.inputs.text, /double bun/)
})

