import assert from 'node:assert/strict'
import test from 'node:test'
import { createBackgroundNativeRuntime } from './fixtures/background-native-runtime.mjs'
import { createPolishDraft, POLISH_TOOLS } from '../tavern-plugin/lib/domain/polish-agent.js'

test('真实 DSH：精修工具逐处执行、完成后不再请求模型，跨轮/空闲恢复保留相同前缀', { skip: !process.env.DSH_BOOT_MODULE, timeout: 30000 }, async t => {
  let now = 0
  const runtime = await createBackgroundNativeRuntime(process.env.DSH_BOOT_MODULE, {
    residentOptions: { now: () => now, residentIdleMs: 1000, backgroundTools: [{ name: 'other_tool', description: 'Other task only', parameters: { type: 'object' } }] },
    modelResponse: (input, n) => input.tools.some(tool => tool.name === 'polish_edit') ? [
      { type: 'tool-call', id: 'edit-' + n, name: 'polish_edit', arguments: JSON.stringify({ reason: '更具体', find: '甲。', replace: '甲改。' }) },
      { type: 'tool-call', id: 'finish-' + n, name: 'polish_finish', arguments: '{}' }
    ] : [{ type: 'text', text: '普通后台完成' }]
  })
  t.after(() => runtime.dispose())
  const run = async (body, persistentSessionId) => {
    const draft = createPolishDraft(['甲。'])
    const result = await runtime.runBackground({ sessionId: 'scene-parent', task: 'polish', persistent: true, persistentSessionId,
      selection: { provider: 'scene-fixture', model: 'fixture-text' }, system: '固定精修标准和人物设定', taskText: () => body,
      tools: POLISH_TOOLS, onToolCall: call => draft.call(call), stopToolsWhen: () => draft.finished, acceptWithoutText: () => draft.finished })
    assert.equal(draft.finished, true)
    assert.equal(draft.result().edits.length, 1)
    return result
  }
  const first = await run('正文第一轮：甲。')
  assert.equal(runtime.requests.length, 1, '完成工具应直接结束，不额外请求总结')
  assert.deepEqual(runtime.requests[0].tools.map(tool => tool.name).sort(), ['polish_edit', 'polish_finish'])
  const second = await run('正文第二轮：甲。', first.traceSessionId)
  assert.equal(second.traceSessionId, first.traceSessionId)
  assert.deepEqual(runtime.requests[1].system, runtime.requests[0].system)
  assert.deepEqual(runtime.requests[1].tools, runtime.requests[0].tools)
  assert.deepEqual(runtime.requests[1].messages.slice(0, runtime.requests[0].messages.length), runtime.requests[0].messages)
  now = 1000
  await runtime.reapBackground()
  assert.deepEqual(runtime.backgroundLoaded(first.traceSessionId), { agent: false, session: false })
  await runtime.restart()
  const third = await run('正文第三轮：甲。', first.traceSessionId)
  assert.equal(third.traceSessionId, first.traceSessionId)
  assert.deepEqual(runtime.requests[2].system, runtime.requests[0].system)
  assert.deepEqual(runtime.requests[2].tools, runtime.requests[0].tools)
  assert.match(JSON.stringify(runtime.requests[2].messages), /正文第一轮/)
  const ordinary = await runtime.runBackground({ sessionId: 'scene-parent', task: 'candidate', persistent: true,
    selection: { provider: 'scene-fixture', model: 'fixture-text' }, messages: [], tools: [] })
  assert.notEqual(ordinary.traceSessionId, first.traceSessionId)
  assert.ok(!runtime.requests.at(-1).tools.some(tool => tool.name === 'polish_edit'))
})


test('真实 alpha.2：后台关闭世界书时既不声明也不执行，持久成员下次启用后恢复声明', { skip: !process.env.DSH_BOOT_MODULE, timeout: 30000 }, async t => {
  let enabled = false
  const runtime = await createBackgroundNativeRuntime(process.env.DSH_BOOT_MODULE, {
    residentOptions: { resolveWorldbookSkills: async () => enabled },
    modelResponse: (_input, n) => n === 1 ? [{ type: 'tool-call', id: 'closed-worldbook', name: 'worldbook_list', arguments: '{}' }] : [{ type: 'text', text: '后台完成' }]
  })
  t.after(() => runtime.dispose())
  const input = { sessionId: 'scene-parent', task: 'candidate', persistent: true,
    selection: { provider: 'scene-fixture', model: 'fixture-text' }, messages: [], tools: [] }
  const first = await runtime.runBackground(input)
  for (const request of runtime.requests) assert.ok(!request.tools.some(tool => ['read', 'worldbook_list', 'worldbook_grep'].includes(tool.name)))
  assert.match(JSON.stringify(runtime.traceEvents(first.traceSessionId)), /该工具在当前 Tavern 会话或任务中已关闭/)
  enabled = true
  const second = await runtime.runBackground({ ...input, persistentSessionId: first.traceSessionId })
  assert.equal(second.traceSessionId, first.traceSessionId)
  for (const name of ['read', 'worldbook_list', 'worldbook_grep']) assert.ok(runtime.requests.at(-1).tools.some(tool => tool.name === name), name)
})
