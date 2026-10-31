import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveChatBackgroundModel } from '../tavern-plugin/lib/domain/background-model-selection.js'
import { createBackgroundAgentRunner } from '../tavern-plugin/lib/background-agent-runner.js'

test('任务发送前完整提交模型选择，选择失败时停止发送', async t => {
  const calls = []
  let rejectSelection = false
  const runner = createBackgroundAgentRunner({
    id: () => 'background-model-unit',
    agents: {
      get: () => ({ id: 'parent', session: { header: {} } }),
      async create(options) {
        await options.setup({ on() {}, systemPrompt: { section() {}, suppressRuntimeContext() {} },
          tools: { restrict() {}, register() {} } })
        const session = { events: [], append(type, data) { this.events.push({ type, data }) } }
        return { agent: {
          session,
          model: { select(selection) {
            calls.push(['select', { ...selection }])
            if (rejectSelection) throw new Error('模型选择写入失败')
          } },
          followup() {
            calls.push(['followup'])
            session.append('assistant/message', { message: { content: [{ type: 'text', text: '完成' }] } })
          },
          async whenIdle() {}
        }, async dispose() {} }
      }
    }
  })
  t.after(() => runner.dispose())
  const run = selection => runner.run({ sessionId: 'parent', task: 'candidate', persistent: true,
    ownPrefix: true, taskText: '合成任务', selection, messages: [], tools: [] })
  const first = { provider: 'one', model: 'model', reasoningEffort: 'high' }
  const next = { provider: 'two', model: 'other' }
  await run(first)
  await run(next)
  assert.deepEqual(calls, [['select', first], ['followup'], ['select', next], ['followup']])
  rejectSelection = true
  await assert.rejects(run(first), /模型选择写入失败/)
  assert.equal(calls.filter(call => call[0] === 'followup').length, 2)
})

test('全局切换覆盖老游戏快照与本局选择，后续本局修改可单独生效', async () => {
  const { applyTavernSettingsPatch } = await import('../tavern-plugin/lib/domain/tavern-settings.js')
  const front = { provider: 'front', model: 'current', reasoningEffort: 'low' }
  const old = { backgroundModelSelection: { provider: 'old', model: 'frozen', reasoningEffort: 'high' } }
  let settings = applyTavernSettingsPatch({}, { backgroundModel: { provider: 'new', model: 'worker' } })
  assert.deepEqual(resolveChatBackgroundModel(old, front, settings), { provider: 'new', model: 'worker' })
  assert.deepEqual(resolveChatBackgroundModel({}, front, settings), { provider: 'new', model: 'worker' })
  const local = { backgroundModelSelection: { provider: 'local', model: 'one-game' }, backgroundModelRevision: settings.backgroundModelRevision }
  assert.deepEqual(resolveChatBackgroundModel(local, front, settings), local.backgroundModelSelection)
  settings = applyTavernSettingsPatch(settings, { backgroundModel: { provider: 'new', model: 'worker', reasoningEffort: 'max' } })
  assert.equal(resolveChatBackgroundModel(local, front, settings).reasoningEffort, 'max')
  assert.equal(resolveChatBackgroundModel(old, front, settings).reasoningEffort, 'max')
  settings = applyTavernSettingsPatch(settings, { backgroundModel: null })
  assert.deepEqual(resolveChatBackgroundModel(old, front, settings), front)
  assert.deepEqual(resolveChatBackgroundModel(local, front, settings), front)
  const revision = settings.backgroundModelRevision
  settings = applyTavernSettingsPatch(settings, { webSearchEnabled: true })
  assert.equal(settings.backgroundModelRevision, revision)
  assert.deepEqual(resolveChatBackgroundModel({ ...local, backgroundModelSelection: null, backgroundModelRevision: revision }, front, settings), front)
})
