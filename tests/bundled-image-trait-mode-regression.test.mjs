import test from 'node:test'
import assert from 'node:assert/strict'
import { expandRosterCalls, injectDefinitions } from '../tavern-plugin/packages/dsh-tavern-image-bundled/lib/index.js'
import { resolveImageReferences } from '../tavern-plugin/packages/dsh-tavern-image-bundled/lib/reference-images.js'

// Fictional adult character: each trait and outfit field has a unique marker so leakage is visible.
const adult = {
  id: 'adult-25', name: 'Ari', match: 'Ari', age: 25, enabled: true,
  traits: {
    face: 'FACE_ADULT_25_ONLY',
    bodySFW: 'BODY_SFW_ONLY',
    bodyNSFW: 'BODY_NSFW_ONLY',
    lowerSFW: 'LOWER_SFW_ONLY',
    lowerNSFW: 'LOWER_NSFW_ONLY',
    negative: 'TRAIT_NEGATIVE_ONLY',
  },
  referenceImage: { id: 'a'.repeat(64), mediaType: 'image/png', name: 'ari.png', byteLength: 64 },
  outfits: [{
    id: 'adult-outfit', name: 'Everyday', default: true,
    upper: 'OUTFIT_UPPER_ONLY', lower: 'OUTFIT_LOWER_ONLY',
    shoes: 'OUTFIT_SHOES_ONLY', full: 'OUTFIT_FULL_ONLY',
    negative: 'OUTFIT_NEGATIVE_ONLY',
    referenceImage: { id: 'b'.repeat(64), mediaType: 'image/png', name: 'outfit.png', byteLength: 64 },
  }],
}
const definitions = { characters: [adult] }
const macro = fields => '${' + JSON.stringify({ name: 'Ari', ...fields }).slice(1, -1) + '}$'
const expand = (traitMode, fields = {}) => expandRosterCalls(macro(fields), definitions, traitMode, { style: 'tags' })

test('traitMode auto and sfw select only ordinary body blocks for an ordinary scene', () => {
  for (const traitMode of ['auto', 'sfw']) {
    const prompt = expand(traitMode, { upperBody: 'sfw', lowerBody: 'sfw', outfit: 'Everyday', age: 25 })
    assert.match(prompt, /FACE_ADULT_25_ONLY/, traitMode)
    assert.match(prompt, /BODY_SFW_ONLY/, traitMode)
    assert.match(prompt, /LOWER_SFW_ONLY/, traitMode)
    assert.doesNotMatch(prompt, /BODY_NSFW_ONLY|LOWER_NSFW_ONLY/, traitMode)
    assert.match(prompt, /OUTFIT_LOWER_ONLY/, traitMode)
  }
})

test('traitMode auto selects only the explicitly NSFW upper block and keeps the SFW lower block', () => {
  const prompt = expand('auto', { upperBody: 'nsfw', lowerBody: 'sfw', outfit: 'Everyday', age: 25 })
  assert.match(prompt, /FACE_ADULT_25_ONLY/)
  assert.match(prompt, /BODY_NSFW_ONLY/)
  assert.match(prompt, /LOWER_SFW_ONLY/)
  assert.doesNotMatch(prompt, /BODY_SFW_ONLY|LOWER_NSFW_ONLY|OUTFIT_UPPER_ONLY|OUTFIT_FULL_ONLY/)
  assert.match(prompt, /OUTFIT_LOWER_ONLY/)
})

test('traitMode all selects NSFW trait blocks without leaking SFW blocks', () => {
  const prompt = expand('all', { outfit: 'Everyday', age: 25 })
  assert.match(prompt, /FACE_ADULT_25_ONLY/)
  assert.match(prompt, /BODY_NSFW_ONLY/)
  assert.match(prompt, /LOWER_NSFW_ONLY/)
  assert.doesNotMatch(prompt, /BODY_SFW_ONLY|LOWER_SFW_ONLY/)
  assert.match(prompt, /25/)
})

test('hidden upper plus NSFW lower keeps only the visible NSFW trait and suppresses clothing', () => {
  const prompt = expand('auto', { upperBody: 'hidden', lowerBody: 'nsfw', outfit: 'Everyday' })
  assert.match(prompt, /LOWER_NSFW_ONLY/)
  assert.doesNotMatch(prompt, /FACE_ADULT_25_ONLY|BODY_SFW_ONLY|BODY_NSFW_ONLY|LOWER_SFW_ONLY/)
  assert.doesNotMatch(prompt, /OUTFIT_UPPER_ONLY|OUTFIT_LOWER_ONLY|OUTFIT_SHOES_ONLY|OUTFIT_FULL_ONLY/)
})

test('all mode retains trait and outfit negatives through normal named injection', () => {
  const raw = 'Ari stands beside a window.'
  const injected = injectDefinitions(raw, definitions, { traitMode: 'all' }, { raw })
  assert.ok(injected.text.includes('BODY_NSFW_ONLY'))
  assert.ok(injected.negatives.includes('TRAIT_NEGATIVE_ONLY'))
  assert.ok(injected.negatives.includes('OUTFIT_NEGATIVE_ONLY'))
})

test('hidden plus NSFW macro retains identity reference and excludes the default outfit reference', () => {
  const result = resolveImageReferences({
    definitions,
    text: macro({ upperBody: 'hidden', lowerBody: 'nsfw' }),
  })
  assert.ok(result.references.some(reference => reference.kind === 'character'))
  assert.ok(result.references.every(reference => reference.kind !== 'outfit'))
  assert.equal(result.subjects[0].outfitId, '')
})
