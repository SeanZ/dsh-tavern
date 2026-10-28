import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlayWorldBook } from '../tavern-plugin/lib/domain/play-world-book.js'
import { UpstreamTemplateRuntime } from './fixtures/upstream-template-runtime.mjs'
const runtime = await UpstreamTemplateRuntime.create()
const entry = (ref, content, extra = {}) => ({ ref, comment: '[mvu_update]' + ref, enabled: true, content, ...extra })
const rules = entries => createPlayWorldBook({ worldBooks: { bound: async () => ({ view: { entries } }) }, runtime: async () => runtime }).mvuUpdateRules

test('MVU renders current input and conditional rules against settlement baseline, excluding other controllers', async () => {
  const entries = [entry('plain', '角色：{{char}}'),
    entry('input', '<%- lastUserMessage %>'),
    entry('signal', "<% if (Array.isArray(getMessageVar('stat_data.事件.信号'))) { %>信号规则<% } %>"),
    entry('disabled', '<% throw new Error("disabled") %>', { enabled: false }),
    entry('ordinary', '<% throw new Error("ordinary") %>', { comment: '普通动态', constant: true })]
  const chat = { messages: [{ role: 'user', text: '查看公会任务' }, { role: 'assistant', text: '任务列表', variables: [{ stat_data: { 事件: { 信号: [] } } }] }] }
  const render = rules(entries)
  const absent = await render(chat, { name: '命定之诗' }, { variables: { stat_data: { 事件: {} } } })
  assert.deepEqual(absent.sort(), ['角色：命定之诗', '查看公会任务'].sort())
  const present = await render(chat, { name: '命定之诗' }, { variables: { stat_data: { 事件: { 信号: [] } } } })
  assert.deepEqual(present.sort(), ['角色：命定之诗', '查看公会任务', '信号规则'].sort())
})
test('MVU template failure stops settlement instead of silently dropping rules or forwarding EJS', async () => {
  await assert.rejects(rules([entry('broken', '<% throw new Error("broken") %>')])({ messages: [] }, {}), /MVU 更新规则模板执行失败/)
})
