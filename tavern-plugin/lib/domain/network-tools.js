// One policy for model visibility and dispatch. Read the owning chat through
// Tavern's store, never through its on-disk representation or a cached tool list.
export function createNetworkToolPolicy({ readHeader, backgroundContext, capabilityFor }) {
  const capability = name => name === 'web_search' ? 'search' : name === 'web_fetch' ? 'fetch' : capabilityFor(name)
  async function resolve(session) {
    if (!session?.id) return null
    const background = backgroundContext(session.id)
    const fields = ['mode', 'webSearchEnabled', 'disabledForegroundTools']
    // A fork can have a parent and still own its own chat.
    const own = background ? null : await readHeader(session.id, fields)
    if (own) return { chat: own, background: false, allowed: true }
    const parent = background?.parentSessionId || session.header?.parentSession || session.meta?.parentSession
    if (!parent) return null
    const chat = await readHeader(parent, fields)
    return chat ? { chat, background: true, allowed: !background || background.webSearchEnabled === true } : null
  }
  function reason(name, state) {
    const kind = capability(name)
    if (!kind || !state) return undefined
    if (!state.allowed || (state.chat.mode !== 'card' && state.chat.webSearchEnabled !== true)) return '本局联网搜索已关闭，请在本局设置中开启。'
    if (!state.background && state.chat.mode !== 'card' && state.chat.disabledForegroundTools?.includes(name)) return '该工具已在本局的前台工具设置中关闭。'
    return undefined
  }
  return {
    async denial(name, session) {
      if (!capability(name)) return undefined
      return reason(name, await resolve(session))
    },
    async filter(tools, session) {
      if (!tools.some(tool => capability(tool.name))) return tools
      const state = await resolve(session)
      return tools.filter(tool => !reason(tool.name, state))
    }
  }
}

export function installNetworkToolPolicy(ctx, policy) {
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    const original = assembly.tools || ctx.tools?.schemas(context.scope || context.agent, context.toolSet) || []
    const tools = await policy.filter(original, context.agent?.session)
    if (Array.isArray(assembly.tools)) assembly.tools = tools
    const removed = new Set(original.filter(tool => !tools.includes(tool)).map(tool => 'tool:' + tool.name))
    assembly.sections = (assembly.sections || []).filter(section => !removed.has(section.name))
    return assembly
  })
  // Unlike the synchronous tools.guard, this official hook can re-read settings
  // when a model returns a call after the player has turned networking off.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const reason = await policy.denial(exec.name, exec.agent?.session)
    return reason ? { kind: 'deny', reason } : next()
  })
}
