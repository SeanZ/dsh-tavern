import { markRequestHandled, requestHandledBy } from './request-lineage.js'

// 与后台提示词装配共用规则；工具列表来自当前任务，不依赖持久成员的旧任务。
export function filterBackgroundTools(tools, context) {
  if (context.task === 'phone') return []
  if (['polish', 'stage-director'].includes(context.task) || context.ownPrefix === true) {
    const names = new Set(context.toolNames || [])
    return tools.filter(tool => names.has(tool.name))
  }
  return context.worldbookSkillsEnabled ? tools : tools.filter(tool => !['read', 'worldbook_list', 'worldbook_grep'].includes(tool.name))
}

// 新宿主的提示词 waterfall 不再拥有工具声明。这里只缩小既有请求，不注册或扩张能力。
export function installToolPresentationPolicy(ctx, { filter, sessionFor }) {
  const stage = 'tavern-tool-policy'
  ctx.on('llm/stream', function (request, next) {
    if (requestHandledBy(request, stage) || !Array.isArray(request.tools)) return next()
    return (async function * () {
      const session = sessionFor(request.sessionId)
      if (!session) { yield * next(); return }
      const tools = await filter(request.tools, session)
      if (tools.length === request.tools.length && tools.every((tool, index) => tool === request.tools[index])) {
        yield * next()
        return
      }
      yield * ctx.llm.stream(markRequestHandled({ ...request, tools }, stage))
    })()
  })
  // 模型看到工具后仍可能发生设置变化；执行前重新检查，禁止声明与分发产生权限落差。
  ctx.on('tools/pre-execute', async (execution, next) => {
    const session = execution.agent?.session
    if (!session) return next()
    const candidate = { name: execution.name }
    const permitted = await filter([candidate], session)
    return permitted.includes(candidate) ? next() : { kind: 'deny', reason: '该工具在当前 Tavern 会话或任务中已关闭。' }
  })
}
