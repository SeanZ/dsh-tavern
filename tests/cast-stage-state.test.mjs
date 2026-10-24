import assert from 'node:assert/strict'
import test from 'node:test'
import { emptyStageState, foldStageState } from '../tavern-plugin/lib/domain/cast-stage-state.js'
import { createPluginTurnReader } from '../tavern-plugin/lib/domain/plugin-turns.js'

test('only explicit deltas change persistent figures, expressions, background and music', () => {
  const first = foldStageState(emptyStageState(), { figures: [{ speaker: 'Nora', emotion: 'joy' }], background: 'Room', music: 'Theme' })
  assert.deepEqual(foldStageState(first, {}), first)
  const next = foldStageState(first, { figures: [{ speaker: 'Nora' }, { speaker: 'Lee' }], background: null })
  assert.deepEqual(next, { figures: [{ speaker: 'Nora', emotion: 'joy' }, { speaker: 'Lee', emotion: 'neutral' }], background: null, music: 'Theme' })
  assert.equal(first.figures.length, 1, 'fold never mutates an earlier snapshot')
  assert.deepEqual(foldStageState(next, { figures: [{ speaker: 'Nora', remove: true }], music: null }), { figures: [{ speaker: 'Lee', emotion: 'neutral' }], background: null, music: null })
  assert.deepEqual(foldStageState(first, { figures: null, background: null, music: null }), emptyStageState())
})

test('historical text keys share one scene read and match the existing single-turn reader', async () => {
  let reads = 0
  const chat = { id: 'chat', mode: 'story', messages: [
    { role: 'assistant', turn: 2, text: 'First.' }, { role: 'assistant', turn: 3, text: 'Second.' }
  ] }
  const turns = createPluginTurnReader({ sceneState: async () => { reads++; return chat } })
  const keys = await turns.currentKeys('game', [2, 3, 4])
  assert.equal(reads, 1)
  assert.equal(keys.get(2), await turns.currentKey('game', 2))
  assert.equal(keys.get(3), await turns.currentKey('game', 3))
  assert.ok(keys.get(2))
  assert.notEqual(keys.get(2), keys.get(3))
  assert.equal(keys.get(4), null)
  const count = reads
  assert.deepEqual(await turns.currentKeys('game', []), new Map())
  assert.equal(reads, count)
})
