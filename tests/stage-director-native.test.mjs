import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { createBackgroundNativeRuntime } from './fixtures/background-native-runtime.mjs'
import { stageDirectorFixture } from './helpers/stage-director-fixture.mjs'

test('native director restricts globals but exposes its local submit tool and repairs in the same session', { skip: !process.env.DSH_BOOT_MODULE, timeout: 30000 }, async t => {
  const { LlmAdapter } = await import(new URL('../../dsh-llm/lib/index.js', pathToFileURL(process.env.DSH_BOOT_MODULE)))
  const requests = []
  class Model extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id } }
    async *stream(input) {
      requests.push(input)
      assert.deepEqual(input.tools.map(tool => tool.name), ['stage_update'])
      const note = input.messages.flatMap(message => message.content || []).map(block => block.text || '').join('\n').split('\n').find(line => line.startsWith('{"window":'))
      const { first, ...seal } = JSON.parse(note).window
      const block = { type: 'tool-call', id: 'direction-' + requests.length, name: 'stage_update', arguments: JSON.stringify({ ...seal, music: requests.length === 1 ? 'Missing' : 'Theme' }) }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  const runtime = await createBackgroundNativeRuntime(process.env.DSH_BOOT_MODULE, {
    setupHost(ctx) { return ctx.llm.registerAdapter(['stage-native-fixture'], new Model()) }
  })
  t.after(() => runtime.dispose())
  const fixture = await stageDirectorFixture({ id: 'story', sessionId: 'scene-parent', mode: 'story', timeline: { branchId: 'branch', revision: 1 },
    messages: [{ role: 'assistant', turn: 1, text: 'The music begins.' }] },
  { player: 'Reader', cast: [], background: [], music: [{ name: 'Theme' }] }, {
    selection: async () => ({ provider: 'stage-native-fixture', model: 'fixed' }), runAgent: input => runtime.runBackground(input)
  })
  await fixture.director.run(await fixture.body())
  assert.equal(requests.length, 2)
  assert.equal(requests[0].sessionId, requests[1].sessionId)
  assert.notEqual(requests[0].sessionId, 'scene-parent')
  assert.ok(requests[1].messages.some(message => message.role === 'tool' && message.content.some(block => block.text?.includes('"retryable":true'))))
  assert.equal((await fixture.director.state('scene-parent', 1)).music, 'Theme')
  assert.equal((await fixture.data.snapshot('story')).owners['dsh-tavern.stage'].turns.length, 1)
})
