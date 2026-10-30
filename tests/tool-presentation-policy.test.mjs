import test from 'node:test'
import assert from 'node:assert/strict'
import { filterBackgroundTools, installToolPresentationPolicy } from '../tavern-plugin/lib/domain/tool-presentation-policy.js'
import { markRequestHandled } from '../tavern-plugin/lib/domain/request-lineage.js'

function fixture() {
  const hooks = {}, seen = []
  let disabled = new Set(['closed']), calls = 0
  const session = { id: 'game' }
  const ctx = {
    on(name, hook) { hooks[name] = hook },
    llm: { stream(request) { return hooks['llm/stream'](request, async function * () { seen.push(request); yield { type: 'finish' } }) } }
  }
  installToolPresentationPolicy(ctx, {
    sessionFor: id => id === session.id ? session : null,
    async filter(tools) { calls++; return tools.filter(tool => !disabled.has(tool.name)) }
  })
  return { hooks, ctx, seen, session, calls: () => calls, disable: name => disabled.add(name) }
}

test('请求只缩小既有工具，不修改冻结输入；复制后的重分发不会循环', async () => {
  const f = fixture()
  const tools = Object.freeze([{ name: 'open' }, { name: 'closed' }])
  const request = Object.freeze({ sessionId: 'game', tools, messages: [] })
  for await (const event of f.ctx.llm.stream(request)) assert.equal(event.type, 'finish')
  assert.deepEqual(f.seen[0].tools, [tools[0]])
  assert.equal(request.tools.length, 2)
  for await (const _ of f.ctx.llm.stream(markRequestHandled({ ...f.seen[0] }, 'other-projection'))) {}
  assert.equal(f.calls(), 1)
})

test('执行前重新检查设置，已关闭工具不能调用下游；非酒馆请求保持原样', async () => {
  const f = fixture()
  let dispatched = 0
  const next = () => { dispatched++; return { kind: 'allow' } }
  assert.deepEqual(await f.hooks['tools/pre-execute']({ name: 'open', agent: { session: f.session } }, next), { kind: 'allow' })
  f.disable('open')
  assert.equal((await f.hooks['tools/pre-execute']({ name: 'open', agent: { session: f.session } }, next)).kind, 'deny')
  assert.equal(dispatched, 1)
  const request = { sessionId: 'unrelated', tools: [{ name: 'closed' }] }
  for await (const _ of f.ctx.llm.stream(request)) {}
  assert.equal(f.seen[0], request)
})


test('后台按当前任务缩小工具：精修和独立前缀仅自身工具，关闭世界书禁用三个读工具', () => {
  const tools = ['polish_edit', 'polish_finish', 'member_tool', 'read', 'worldbook_list', 'worldbook_grep', 'skill'].map(name => ({ name }))
  const names = context => filterBackgroundTools(tools, context).map(tool => tool.name)
  assert.deepEqual(names({ task: 'polish', toolNames: ['polish_edit', 'polish_finish'] }), ['polish_edit', 'polish_finish'])
  assert.deepEqual(names({ task: 'plugin', ownPrefix: true, toolNames: ['member_tool'] }), ['member_tool'])
  assert.deepEqual(names({ task: 'stage-director', toolNames: ['member_tool'] }), ['member_tool'])
  assert.deepEqual(names({ task: 'phone', worldbookSkillsEnabled: true }), [])
  assert.deepEqual(names({ task: 'settlement', worldbookSkillsEnabled: false }), ['polish_edit', 'polish_finish', 'member_tool', 'skill'])
  assert.equal(filterBackgroundTools(tools, { task: 'candidate', worldbookSkillsEnabled: true }), tools)
})
