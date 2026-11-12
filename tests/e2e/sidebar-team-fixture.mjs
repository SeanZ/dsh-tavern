import { pathToFileURL } from 'node:url'

// 仅用于本地隔离宿主；真实团队、子代理、投影与存储，只固定模型输出。
export const inject = ['agents', 'agentTeams', 'subagents', 'sessions', 'sessionController', 'webServer', 'llm']
export async function apply(ctx) {
  if (process.env.TAVERN_E2E_SIDEBAR_FIXTURE !== '1' || !process.env.DSH_HOME?.includes('/.artifacts/sidebar-rc2-')) {
    throw new Error('Tasks验收插件只允许显式隔离实例')
  }
  const { LlmAdapter } = await import(pathToFileURL(process.env.TAVERN_E2E_LLM_MODULE))
  const held = new Map()
  class Model extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: '侧栏验收固定模型', context: { contextWindow: 64000 } } }
    async *stream(input) {
      const text = JSON.stringify(input.messages)
      const hold = [...held.keys()].find(key => text.includes(key))
      if (hold) await held.get(hold).promise
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '合成任务已完成。' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['sidebar-fixture'], new Model())
  const handles = new Map()
  const roots = new Set()
  const signal = new AbortController().signal
  const dispatch = async body => {
    if (body.action === 'create') {
      const id = 'sidebar-fixture-' + crypto.randomUUID()
      const handle = await ctx.agents.create({ sessionId: id, meta: { cwd: process.env.DSH_CWD }, agentOptions: { provider: 'sidebar-fixture', model: 'fixed' } })
      handles.set(id, handle)
      roots.add(id)
      if (body.enabled) await ctx.agentTeams.setEnabled(handle.agent, true)
      await ctx.sessions.flush(handle.agent.session)
      return { id }
    }
    if (!roots.has(body.id)) throw new Error('仅允许本插件创建的合成根会话')
    if (body.action === 'cold') {
      await handles.get(body.id).dispose()
      handles.delete(body.id)
      return { cold: ctx.agents.get(body.id) === undefined }
    }
    if (body.action === 'state') return await ctx.sessionController.projections({ sessionId: body.id }, signal)
    const root = ctx.agents.get(body.id) ?? (await ctx.sessionController.resolveAgent(body.id)).agent
    if (!root) throw new Error('合成根会话未就绪')
    if (body.action === 'mode') {
      await ctx.agentTeams.setEnabled(root, body.enabled)
      return { enabled: ctx.agentTeams.isEnabled(root) }
    }
    if (body.action === 'children') {
      const hold = 'sidebar-hold-' + crypto.randomUUID()
      let release
      const promise = new Promise(resolve => { release = resolve })
      held.set(hold, { promise })
      const spawn = (parent, name, prompt) => ctx.subagents.startActivation({
        provider: 'spawn', name, label: name + '验收成员', parent,
        prompt: [{ type: 'text', text: prompt }], signal, delivery: 'caller',
      })
      try {
        const first = await spawn(root, 'alpha', hold)
        const nested = await spawn(ctx.agents.get(first.childId), 'worker', '嵌套合成任务')
        await nested.result
        const second = await spawn(root, 'beta', '并列合成任务')
        await second.result
        release()
        await first.result
        return { alpha: first.childId, nested: nested.childId, beta: second.childId }
      } finally { release(); held.delete(hold) }
    }
    throw new Error('未知验收动作')
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/sidebar-fixture', handler: async (req, res) => {
    try {
      if (req.method !== 'POST') throw new Error('仅允许POST')
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const result = await dispatch(JSON.parse(Buffer.concat(chunks).toString()))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(result))
    } catch (error) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: error.message }))
    }
  } }))
}
