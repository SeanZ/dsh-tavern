import assert from 'node:assert/strict'
import test from 'node:test'
import { stageDirectorFixture } from './helpers/stage-director-fixture.mjs'
import { createBackgroundAgentRunner } from '../tavern-plugin/lib/background-agent-runner.js'
import { createForegroundHandoff } from '../tavern-plugin/lib/domain/foreground-handoff.js'

const chat = () => ({ id: 'story', sessionId: 'game', mode: 'story', timeline: { branchId: 'branch', revision: 1 },
  messages: [{ role: 'assistant', turn: 1, text: 'A figure arrives.\n\nAfter the interruption, the room becomes quiet.' }] })
const assets = () => ({ player: 'Reader', cast: [{ name: 'Nora' }], background: [{ name: 'Room' }], music: [{ name: 'Theme' }] })
const delta = { sequence: 1, through: 2, done: true, figures: [{ speaker: 'Nora', emotion: 'sadness' }], background: 'Room', music: 'Theme' }

test('director runs while the resident settlement session is still blocked', { timeout: 5000 }, async () => {
  let release, started, id = 0, settled = false
  const blocked = new Promise(resolve => { release = resolve }), ready = new Promise(resolve => { started = resolve })
  const descriptors = [], resolved = []
  const runner = createBackgroundAgentRunner({ id: () => 'child-' + ++id, backgroundTools: [{ name: 'posture_submit' }],
    resolveModelSelection: async input => { resolved.push(input.task); return { provider: 'existing-background', model: 'configured' } },
    resolveStablePrefix: async input => { assert.equal(input.task, 'settlement'); return '' },
    resolveCurrentWorldbook: async input => { assert.equal(input.task, 'settlement'); return '' },
    resolveForegroundWorldbookReads: async input => { assert.equal(input.task, 'settlement'); return '' },
    agents: { get: () => ({ id: 'game', session: { header: {} } }), async create(options) {
      assert.deepEqual(options.agentOptions, { provider: 'existing-background', model: 'configured' })
      const tools = new Map()
      await options.setup({ systemPrompt: { section() {}, suppressRuntimeContext() {} }, on() {},
        tools: { restrict({ allow }) { assert.ok(!allow.includes('stage_update'), 'restrict accepts global tools only; stage_update is registered locally') }, register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } } })
      const session = { id: options.sessionId, events: [], append(type, data) {
        this.events.push({ type, data }); if (type === 'subagent/descriptor') descriptors.push(data)
      } }
      let work
      return { agent: { session, followup() { work = (async () => {
        if (tools.has('stage_update')) {
          assert.equal(tools.has('posture_submit'), false)
          assert.equal(settled, false)
          assert.deepEqual(JSON.parse(await tools.get('stage_update').execute(delta)), { ok: true })
        } else { started(); await blocked; settled = true }
        session.append('assistant/message', { message: { content: [{ type: 'text', text: 'Done.' }] } })
      })() }, async whenIdle() { await work } }, async dispose() {} }
    } } })
  const settlement = runner.run({ sessionId: 'game', task: 'settlement', persistent: true, messages: [], tools: [] })
  try {
    await ready
    const h = await stageDirectorFixture(chat(), assets(), { runAgent: input => runner.run(input) })
    await h.director.run(await h.body())
    assert.equal(settled, false)
    assert.equal((await h.director.state('game', 1)).music, 'Theme')
    assert.equal(id, 2, 'independent native sessions')
    assert.deepEqual(resolved, ['settlement', 'stage-director'])
    assert.ok(descriptors.some(item => item.provider === 'dsh-tavern-stage'))
  } finally { release(); await settlement; await runner.dispose() }
})

for (const pending of [false, true]) test('host body completion starts director independently; settlement pending=' + pending, async () => {
  const calls = []
  const handoff = createForegroundHandoff({
    turns: { async finalize() {}, async discard() {} }, store: { async chatForSession() { return { id: 'story' } } },
    tasks: { activity: () => pending ? { role: 'settlement', phase: 'pending' } : { phase: 'idle' } },
    replyCommitted: id => calls.push('director:' + id), queueBackground: async id => { calls.push('settlement:' + id) },
    defer: work => work()
  })
  handoff.end({ sessionId: 'game', reason: 'completed' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, pending ? ['director:game', 'settlement:story'] : ['director:game'])
})


test('closed or cancelled director sessions cannot publish late tools', async () => {
  for (const cancel of [false, true]) {
    let captured
    const controller = new AbortController()
    const h = await stageDirectorFixture(chat(), assets(), {runAgent: async input => {
      captured = input
      if (cancel) {
        controller.abort()
        assert.equal(JSON.parse(await input.onToolCall({arguments:delta},{signal:controller.signal})).ok, false)
      }
    }})
    await h.director.run(await h.body(), controller.signal)
    assert.equal(JSON.parse(await captured.onToolCall({arguments:delta})).ok, false)
    assert.equal(await h.data.snapshot('story'), null)
  }
})
