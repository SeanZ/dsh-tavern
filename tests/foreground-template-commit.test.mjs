import { projectFullPromptTemplateState } from '../tavern-plugin/lib/domain/full-prompt-template-state.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { app, base, history, saveTemplate } from './fixtures/foreground-preparation.mjs'
import { createContextPlanner } from '../tavern-plugin/lib/domain/context-planner.js'

for (const timing of ['duringWorldbook', 'beforePlan', 'beforePatch']) {
  for (const target of ['stored', 'staged']) test(`准备采用正式模板保存的最新状态：${target}/${timing}`, async t => {
    const run = await app(t, base(history(12, () => true), { macroState: { userName: '玩家', local: {}, global: {} } }), true, true, { planner: createContextPlanner({ prompt: key => key }), card: { name: 'Card', post_history_instructions: '当前玩家：{{user}}' } })
    const input = { sessionId: 's', turn: 13, requestId: 'template-13', userText: '继续' }
    await run.turns.appendUser(input)
    run[timing](() => saveTemplate(run, target, 927))
    const prepared = await run.turns.prepare(input)
    const saved = await run.stored()
    assert.equal(prepared.ready, true)
    assert.deepEqual(run.effects, { input: 1, worldbook: 1 }, 'CAS 重试不重复执行模板')
    assert.equal(saved.messages.length, 26)
    assert.equal(saved.messages[24].variables[0].stat_data.hp, 927)
    assert.equal(saved.messages[24].tavernPluginData.template_rendered.hash, 'latest-927')
    assert.equal(saved.messages[24].tavernPluginData.rendered, 13, '保留输入模板原有的其它数据')
    assert.equal(saved.promptTemplateInput.message.variables[0].stat_data.hp, 927)
    assert.equal(saved.promptTemplateInput.message.tavernPluginData.template_rendered.hash, 'latest-927')
    assert.equal(prepared.frame.source.regenerationMaterials.generationState.messageVariables.stat_data.hp, 927)
    assert.equal(prepared.frame.source.regenerationMaterials.generationState.variables.latestTemplate, 927)
    assert.equal(prepared.frame.source.regenerationState.promptTemplateInput.message.tavernPluginData.template_rendered.hash, 'latest-927')
    assert.deepEqual(saved.foregroundFrames[prepared.frame.operationId], prepared.frame)
    assert.match(JSON.stringify(prepared.frame.context), /927/, '实际请求帧正文包含最新变量')
  })
}

test('两次 CAS 冲突均重新读取最新模板状态，且只追加一次占位', async t => {
  const run = await app(t, base(history(12, () => true), { macroState: { userName: '玩家', local: {}, global: {} } }), true, true)
  const input = { sessionId: 's', turn: 13, requestId: 'twice', userText: '继续' }
  await run.turns.appendUser(input)
  run.beforePatch(async () => {
    await saveTemplate(run, 'stored', 501)
    run.beforePatch(() => saveTemplate(run, 'stored', 502))
  })
  const prepared = await run.turns.prepare(input)
  const saved = await run.stored()
  assert.equal(saved.messages.length, 26)
  assert.equal(saved.messages[24].variables[0].stat_data.hp, 502)
  assert.equal(saved.messages[24].tavernPluginData.template_rendered.hash, 'latest-502')
  assert.equal(prepared.frame.source.regenerationMaterials.generationState.messageVariables.stat_data.hp, 502)
  assert.deepEqual(saved.foregroundFrames[prepared.frame.operationId], prepared.frame)
  assert.deepEqual(run.effects, { input: 1, worldbook: 1 })
})

for (const change of ['body', 'swipe', 'branch', 'lifecycle', 'other-plugin']) test(`模板兼容不放宽真正的失效保护：${change}`, async t => {
  const run = await app(t, base(history(12, () => true)), true, true)
  const input = { sessionId: 's', turn: 13, requestId: 'conflict', userText: '继续' }
  await run.turns.appendUser(input)
  run.beforePatch(() => run.persistence.update('chat-1', chat => {
    if (change === 'body') chat.messages[24].text = '用户修改后的输入'
    if (change === 'swipe') chat.messages[24].swipeId = 1
    if (change === 'branch') chat.timeline.branchId = 'new-branch'
    if (change === 'lifecycle') chat.tavernHelperLifecycleRevision = 1
    if (change === 'other-plugin') chat.messages[24].tavernPluginData = { custom: '新插件状态' }
    return chat
  }))
  await assert.rejects(run.turns.prepare(input), { code: 'TAVERN_PREPARE_CONFLICT' })
  assert.equal((await run.stored()).messages.length, 25)
})

test('只更新模板标记也刷新冻结帧；请求提交后的新写入不改变已冻结帧', async t => {
  const run = await app(t, base(history(12, () => true)), true, true)
  const input = { sessionId: 's', turn: 13, requestId: 'metadata-only', userText: '继续' }
  await run.turns.appendUser(input)
  run.beforePatch(async () => {
    const request = projectFullPromptTemplateState(await run.stored())
    request.chat[24].is_ejs_processed = [true]
    request.chat[24].template_rendered = { hash: 'metadata-only', swipe: 0 }
    await run.helper.saveFullPromptTemplateState('s', request)
  })
  const { frame } = await run.turns.prepare(input)
  assert.equal(run.planCalls, 1, '仅更新模板标记不重算提示词或随机宏')
  assert.equal(frame.source.regenerationState.promptTemplateInput.message.tavernPluginData.template_rendered.hash, 'metadata-only')
  const frozen = structuredClone(frame)
  const request = projectFullPromptTemplateState(await run.stored())
  request.chat[24].template_rendered = { hash: 'after-request', swipe: 0 }
  await run.helper.saveFullPromptTemplateState('s', request)
  const saved = await run.stored()
  assert.equal(saved.messages[24].tavernPluginData.template_rendered.hash, 'after-request')
  assert.deepEqual(frame, frozen)
  assert.deepEqual(saved.foregroundFrames[frame.operationId], frozen)
})
