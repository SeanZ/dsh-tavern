import assert from 'node:assert/strict'
import test from 'node:test'
import { HISTORY_ANCHOR_TEXT, projectHistoryAsToolCalls } from '../tavern-plugin/lib/domain/history-tool-call.js'

function body(id, text) {
  return { id, role: 'assistant', source: { kind: 'model', provider: 'dsh-tavern', model: 'reply-projection' }, content: [{ type: 'text', text }] }
}

function player(id, text) {
  return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

const TOOL = 'submit_story'

// These tests are about the projection itself; the anchor turn has its own tests below.
function project(messages, options) {
  const projected = projectHistoryAsToolCalls(messages, options)
  return projected === messages ? projected : projected.filter(message => !String(message.id).endsWith(':anchor'))
}

test('插件注入、思维链、已有工具回合与空消息保持原样', () => {
  const plugin = { role: 'assistant', source: { kind: 'plugin:dsh-tavern' }, content: [{ type: 'text', text: '插件注入' }] }
  const pluginUser = { role: 'user', source: { kind: 'plugin:dsh-tavern' }, content: [{ type: 'text', text: '规则' }] }
  const reasoned = { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'reasoning', text: '思考' }, { type: 'text', text: '正文' }] }
  const native = { role: 'assistant', source: { kind: 'model' },
    content: [{ type: 'tool-call', id: 'c1', name: TOOL, arguments: '{"content":"已有"}' }] }
  const empty = { role: 'assistant', source: { kind: 'model' }, content: [] }
  const blank = { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '   ' }] }
  const system = { role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: '系统' }] }
  const messages = [plugin, pluginUser, reasoned, native, empty, blank, system]
  assert.equal(project(messages, { toolName: TOOL }), messages)
})

test('all 布局把说明性文本也改成调用，系统提示仍是 system', () => {
  const frame = { id: 'frame-1', role: 'user', source: { kind: 'plugin:dsh-tavern' }, content: [{ type: 'text', text: '共同创作虚构小说' }] }
  const system = { id: 'system', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: '规则' }] }
  const messages = [system, frame, body('message-1', '正文'), player('player-2', '继续')]
  const projected = project(messages, { toolName: TOOL, layout: 'all' })
  assert.deepEqual(projected.map(message => message.role), ['system', 'assistant', 'tool', 'assistant', 'tool', 'user'])
  assert.deepEqual(JSON.parse(projected[1].content[0].arguments), { content: '共同创作虚构小说' })
})

test('只由正文组成的历史（导入的旧存档从开场白开始）：开头的调用前补一条固定的 user 轮次（#330）', () => {
  const instruction = { id: 'frame', role: 'user', source: { kind: 'plugin:dsh-tavern' }, content: [{ type: 'text', text: '框架指令' }] }
  const imported = [body('greeting', '开场白'), player('player-1', '我推开门'), body('message-1', '门开了'), player('input', '继续')]
  const projected = projectHistoryAsToolCalls(imported, { toolName: TOOL })
  assert.deepEqual(projected.map(message => message.role), ['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool', 'user'])
  assert.deepEqual(projected[0].content, [{ type: 'text', text: HISTORY_ANCHOR_TEXT }])
  assert.equal(projected[0].id, projected[1].content[0].id + ':anchor')
  assert.deepEqual(projectHistoryAsToolCalls(imported, { toolName: TOOL }), projected, '逐字节稳定，缓存照样命中')
  // 每个调用前面都是 user 轮次或工具结果：严格的 Gemini 渠道接受。
  projected.forEach((message, index) => {
    if (message.role === 'assistant') assert.ok(['user', 'tool'].includes(projected[index - 1].role))
  })

  // 开头已有指令（原生局每轮都有框架指令）：请求与原来一致，不补。
  const native = projectHistoryAsToolCalls([instruction, ...imported], { toolName: TOOL })
  assert.equal(native.some(message => String(message.id).endsWith(':anchor')), false)
})
