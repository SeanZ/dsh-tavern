import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { createBackgroundNativeRuntime } from './fixtures/background-native-runtime.mjs'
import { resolveChatBackgroundModel } from '../tavern-plugin/lib/domain/background-model-selection.js'
import { installHostSessionPatch } from '../tavern-plugin/lib/domain/host-session-patch.js'

const firstModel = { provider: 'scene-fixture', model: 'first', reasoningEffort: 'high' }
const secondModel = { provider: 'scene-fixture-other', model: 'second', reasoningEffort: 'low' }
const input = {
  sessionId: 'scene-parent', task: 'settlement', persistent: true,
  selection: firstModel, backgroundContext: '固定的合成背景', tools: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: '保留的第一次任务' }] }]
}

function requested(runtime, sessionId) {
  const last = runtime.requests.at(-1)
  const config = runtime.traceEvents(sessionId).findLast(event => event.type === 'request/header').data.header.config
  assert.equal(last.model, config.model)
  return { provider: config.provider, model: config.model,
    ...(last.reasoningEffort === undefined ? {} : { reasoningEffort: last.reasoningEffort }) }
}

for (const reload of [false, true]) test(`后台模型切换保留原会话与历史：${reload ? '落盘恢复' : '常驻复用'}`, {
  skip: !process.env.DSH_BOOT_MODULE, timeout: 30000
}, async t => {
  const chat = { backgroundModelSelection: firstModel }
  const runtime = await createBackgroundNativeRuntime(process.env.DSH_BOOT_MODULE, {
    resolveModelSelection: () => resolveChatBackgroundModel(chat, firstModel)
  })
  t.after(() => runtime.dispose())
  const first = await runtime.runBackground(input)
  assert.deepEqual(requested(runtime, first.traceSessionId), firstModel)
  const selections = [secondModel, { ...secondModel, model: 'third' },
    { ...secondModel, model: 'third', reasoningEffort: 'high' },
    { provider: secondModel.provider, model: 'third' }, null]
  for (const selection of selections) {
    if (reload) await runtime.restart()
    chat.backgroundModelSelection = selection
    const next = await runtime.runBackground({ ...input, persistentSessionId: first.traceSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: '切换后任务' }] }] })
    assert.equal(next.traceSessionId, first.traceSessionId)
    assert.deepEqual(requested(runtime, first.traceSessionId), selection || firstModel)
    assert.match(JSON.stringify(runtime.requests.at(-1).messages), /保留的第一次任务/)
  }
  const switches = runtime.traceEvents(first.traceSessionId).filter(event => event.type === 'model/selection').length
  await runtime.runBackground({ ...input, persistentSessionId: first.traceSessionId })
  assert.equal(runtime.traceEvents(first.traceSessionId).filter(event => event.type === 'model/selection').length, switches,
    '相同选择不能重复写入切换事件')
})

for (const reload of [false, true]) test(`旧模型失败后回退并切换模型：${reload ? '落盘恢复' : '常驻复用'}`, {
  skip: !process.env.DSH_BOOT_MODULE, timeout: 30000
}, async t => {
  let selection = firstModel
  let fail = false
  const runtime = await createBackgroundNativeRuntime(process.env.DSH_BOOT_MODULE, {
    resolveModelSelection: () => selection,
    async setupHost(ctx) {
      const patch = await installHostSessionPatch({ hostRequire: createRequire(process.env.DSH_BOOT_MODULE),
        persistence: ctx.get('sessionPersistence'), query: ctx.get('sessionQuery') })
      assert.equal(patch.serverReady, true, patch.reason)
      return () => patch.dispose()
    },
    beforeModelRequest: () => { if (fail) throw new Error('合成模型额度不足') }
  })
  t.after(() => runtime.dispose())
  const first = await runtime.runBackground(input)
  fail = true
  await assert.rejects(runtime.runBackground({ ...input, persistentSessionId: first.traceSessionId,
    messages: [{ role: 'user', content: [{ type: 'text', text: '需要撤回的失败任务' }] }] }), /合成模型额度不足/)
  if (reload) await runtime.restart()
  fail = false
  selection = secondModel
  const recovered = await runtime.runBackground({ ...input, persistentSessionId: first.traceSessionId,
    rewindTo: first.traceBoundary, rewindFormatVersion: 4,
    messages: [{ role: 'user', content: [{ type: 'text', text: '新模型重试任务' }] }] })
  assert.equal(recovered.traceSessionId, first.traceSessionId)
  assert.deepEqual(requested(runtime, first.traceSessionId), secondModel)
  const messages = JSON.stringify(runtime.requests.at(-1).messages)
  assert.match(messages, /保留的第一次任务/)
  assert.doesNotMatch(messages, /需要撤回的失败任务/)
  assert.match(messages, /新模型重试任务/)
})

test('排队任务取最新设置，在执行中的工具多步请求保持原模型', {
  skip: !process.env.DSH_BOOT_MODULE, timeout: 30000
}, async t => {
  let selection = firstModel
  let release, entered, waiting = true
  const gate = new Promise(resolve => { release = resolve })
  const ready = new Promise(resolve => { entered = resolve })
  const runtime = await createBackgroundNativeRuntime(process.env.DSH_BOOT_MODULE, {
    resolveModelSelection: () => selection,
    beforeModelRequest: async () => { if (waiting) { waiting = false; entered(); await gate } },
    modelResponse: (_input, count) => count === 1
      ? [{ type: 'tool-call', id: 'fixture-call', name: 'fixture_lookup', arguments: '{}' }]
      : [{ type: 'text', text: '合成任务完成' }]
  })
  t.after(async () => { release(); await runtime.dispose() })
  const work = runtime.runBackground({ ...input, tools: [{ name: 'fixture_lookup', description: '读取合成状态',
    parameters: { type: 'object', properties: {} } }], onToolCall: async () => '合成状态' })
  await ready
  const queued = runtime.runBackground(input)
  selection = secondModel
  release()
  const [first, next] = await Promise.all([work, queued])
  assert.equal(next.traceSessionId, first.traceSessionId)
  const configs = runtime.traceEvents(first.traceSessionId).filter(event => event.type === 'request/header')
    .map(event => event.data.header.config)
  assert.equal(runtime.requests.length, 3, '首次任务包含工具回传后的第二次请求，之后执行排队任务')
  assert.deepEqual(runtime.requests.map(request => [request.model, request.reasoningEffort]),
    [firstModel, firstModel, secondModel].map(model => [model.model, model.reasoningEffort]))
  // 宿主复用相同的请求头；只有切换选择后才追加新 header。
  assert.deepEqual(configs.map(config => [config.provider, config.model, config.reasoningEffort]),
    [firstModel, secondModel].map(model => [model.provider, model.model, model.reasoningEffort]))
  const sources = runtime.traceEvents(first.traceSessionId).filter(event => event.type === 'assistant/message')
    .map(event => event.data.message.source.provider)
  assert.deepEqual(sources, [firstModel.provider, firstModel.provider, secondModel.provider])
})
