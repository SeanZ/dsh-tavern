import test from 'node:test'
import assert from 'node:assert/strict'
import { compileChannelJob } from '../tavern-plugin/packages/dsh-tavern-image-bundled/lib/index.js'

const channel = { id: 'test', provider: 'novelai', baseUrl: 'https://image.test', model: 'nai-diffusion-4-5-full', apiKey: 'test', options: {} }
const config = { imageBackend: 'novelai', promptMode: 'tags', traitMode: 'default', weightMode: 'auto', negativeMode: 'plugin', sizes: {} }

const alice = {
  id: 'alice', name: 'Alice', match: 'Alice', enabled: true,
  traits: { face: 'long hair', negative: 'hair bun, double bun' }, outfits: [],
}

function compile(params, definitions = { characters: [] }) {
  return compileChannelJob({ params, config, definitions, channel })
}

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
