import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { installToolPresentationPolicy } from '../tavern-plugin/lib/domain/tool-presentation-policy.js'

const require = createRequire(process.env.DSH_BOOT_MODULE || new URL('../package.json', import.meta.url))
const load = name => import(pathToFileURL(require.resolve(name)))
const { Context } = await load('@deepseek-ai/cordis')
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { default: Tools, defineTool } = await load('@deepseek-ai/dsh-tools')
const NativeExecutor = await load('@deepseek-ai/dsh-tool-executor-native')
const { createScope } = await load('@deepseek-ai/dsh-scope')

test('真实 alpha.2 装配分离工具声明，执行管线仍拒绝会话关闭的工具', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(NativeExecutor)
  const agent = { id: 'tool-policy-native', session: { id: 'tool-policy-native' } }
  await ctx.plugin(Object.assign(inner => { createScope(inner, agent) }, { inject: ['tools'] }))
  let calls = 0, closed = false, sawPresentation = false
  ctx.tools.register(defineTool({ name: 'synthetic', description: '合成计数器', parameters: {},
    output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
    async execute() { calls++; return 'ok' }
  }))
  ctx.on('system-prompt/assemble', async (presentation, _context, next) => {
    assert.equal(Object.hasOwn(presentation, 'tools'), false)
    sawPresentation = true
    return next()
  })
  installToolPresentationPolicy(ctx, { sessionFor: () => agent.session, filter: async tools => closed ? [] : tools })
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent, signal, modelSelection: { provider: 'synthetic', model: 'fixed' } })
  t.after(() => toolSet.dispose())
  const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent, signal, toolSet })
  assert.equal(sawPresentation, true)
  assert.deepEqual(assembly.tools.map(tool => tool.name), ['synthetic'])
  const execute = () => ctx.tools.execute({ agent, signal, toolSet, calls: [{ type: 'tool-call', id: 'synthetic-call', name: 'synthetic', arguments: '{}' }] })
  assert.equal((await execute()).results[0].result.isError, false)
  closed = true
  const denied = (await execute()).results[0].result
  assert.equal(denied.isError, true)
  assert.match(JSON.stringify(denied), /当前 Tavern 会话或任务中已关闭/)
  assert.equal(calls, 1)
})
