import { defineTool } from '@deepseek-ai/dsh-tools'
import { createWebSearch, createSearchTransport, TAVERN_SEARCH_PROVIDER } from '../domain/web-search.js'
import { createWebReader, fetchWebPage } from '../domain/web-reader.js'
export { createWebReader } from '../domain/web-reader.js'

export function installWebAccess({ ctx, getConfig }) {
  const transport = createSearchTransport()
  const provider = createWebSearch({ getConfig, request: transport.request })
  ctx.effect(() => () => transport.dispose())
  let web, settings
  async function useBuiltin() {
    if (!web || !settings) throw new Error('搜索服务尚未就绪，请稍后重试')
    await settings.mutate('web', [{ op: 'set', path: ['searchProvider'], value: TAVERN_SEARCH_PROVIDER }])
  }
  ctx.inject(['web', 'settings'], sctx => {
    web = sctx.web; settings = sctx.settings
    web.registerSearchProvider(provider)
    const current = web.config.searchProvider.get() ?? process.env.DSH_WEB_SEARCH_PROVIDER
    // Keep a deliberately selected third-party provider. The settings page can
    // explicitly switch back, and also reports which backend is actually active.
    if (!current || current === 'deepseek-official') void useBuiltin().catch(() => console.warn('dsh-tavern: 内置搜索未能自动启用，可在卡片工作台搜索设置中重试'))
  })
  if (!ctx.tools.get('web_fetch')) {
    const read = createWebReader({ fetchPage: (request, signal) => {
      const runtime = ctx.get('web')
      if (!runtime) throw new Error('网页读取服务尚未就绪')
      return fetchWebPage(runtime, request, signal)
    } })
    ctx.tools.register(defineTool({
      name: 'web_fetch', description: '读取指定 HTTP(S) 网页的正文，返回来源、抓取时间和截断状态。用于核对搜索摘要、补充作品资料；不执行网页脚本。',
      parameters: { url: { type: 'string', required: true, description: '完整网页地址' } },
      output: { schema: { type: 'object', properties: { report: { type: 'string', required: true } }, additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: value.report }] },
      timeoutMs: 25000, isConcurrencySafe: () => true,
      execute: (args, execution) => read(args.url, execution.signal)
    }))
  }
  return {
    status: () => ({ provider: web?.config.searchProvider.get() ?? process.env.DSH_WEB_SEARCH_PROVIDER ?? '', ...provider.diagnostics() }),
    useBuiltin,
    async test() {
      const result = await provider.search({ query: '维基百科', maxResults: 3 })
      return { ...provider.diagnostics(), count: result.sources.length, sources: result.sources }
    }
  }
}
