import { fetch, Agent, ProxyAgent } from 'undici'
import { parseSearchResults, normalizedSources } from './web-content.js'
import { readWebAccess } from './web-access-settings.js'

export const TAVERN_SEARCH_PROVIDER = 'tavern-search'
const error = (code, message) => Object.assign(new Error(message), { code })

// Source requests have bounded decoded bytes and manual redirects: a configured
// SearXNG server must answer here, not silently send the query to a different host.
export function createSearchTransport() {
  const agents = new Map()
  return {
    async request(url, { signal, proxyUrl = '' }) {
      let agent = agents.get(proxyUrl)
      if (!agent) {
        agent = proxyUrl ? new ProxyAgent(proxyUrl) : new Agent()
        agents.set(proxyUrl, agent)
        if (agents.size > 12) {
          const [key, old] = agents.entries().next().value
          agents.delete(key)
          void old.close().catch(() => {})
        }
      }
      let response
      try { response = await fetch(url, { signal, dispatcher: agent, redirect: 'error', headers: { 'user-agent': 'DSH-Tavern/3.1', accept: 'application/json, application/rss+xml, text/html;q=0.9, */*;q=0.1' } }) }
      catch (cause) { if (signal?.aborted) throw signal.reason; throw error('network', '连接失败，请检查网络或搜索代理') }
      if (!response.ok) {
        await response.body?.cancel()
        throw error([401, 403].includes(response.status) ? 'blocked' : response.status === 429 ? 'rate-limit' : 'http', 'HTTP ' + response.status)
      }
      const reader = response.body?.getReader()
      if (!reader) throw error('invalid', '搜索源没有返回内容')
      const parts = []; let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 1_000_000) throw error('invalid', '搜索结果超过 1 MB')
          parts.push(value)
        }
      } finally { await reader.cancel().catch(() => {}) }
      return Buffer.concat(parts).toString('utf8')
    },
    dispose() { for (const agent of agents.values()) void agent.destroy().catch(() => {}); agents.clear() }
  }
}
function searchUrl(source, query, config) {
  const url = source === 'bing' ? new URL('https://www.bing.com/search') : source === 'ddg' ? new URL('https://html.duckduckgo.com/html/') : new URL(config.searxngUrl + '/search')
  url.searchParams.set('q', query)
  if (source === 'bing') url.searchParams.set('format', 'rss')
  if (source === 'searxng') {
    url.searchParams.set('format', 'json')
    if (config.searxngEngines.length) url.searchParams.set('engines', config.searxngEngines.join(','))
  }
  return url.href
}
export function createWebSearch({ getConfig, request, now = Date.now, timeoutMs = 15000, sourceTimeoutMs = 6000 }) {
  const cache = new Map(), cooldowns = new Map()
  let lastConfig = '', recent = []
  const provider = {
    id: TAVERN_SEARCH_PROVIDER,
    available: () => true,
    async search(input, signal) {
      if (typeof input?.query !== 'string' || !input.query.trim() || input.query.length > 2000) throw error('invalid', '搜索词需为 1–2000 字')
      signal?.throwIfAborted()
      const config = readWebAccess(getConfig()), fingerprint = JSON.stringify(config)
      if (fingerprint !== lastConfig) { cache.clear(); cooldowns.clear(); lastConfig = fingerprint }
      const limit = Math.min(10, Math.max(1, Number.isSafeInteger(input.maxResults) ? input.maxResults : 8))
      const query = input.query.trim(), key = JSON.stringify([fingerprint, query, limit])
      const hit = cache.get(key)
      if (hit && hit.expires > now()) return { ...structuredClone(hit.result), cacheHit: true, content: hit.result.content + '\n短期缓存命中；时间为原搜索时间。' }
      const deadline = AbortSignal.timeout(timeoutMs)
      const totalSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
      const attempts = []
      for (const source of config.sources) {
        signal?.throwIfAborted()
        if (totalSignal.aborted) break
        if ((cooldowns.get(source) || 0) > now()) { attempts.push({ source, ok: false, error: '暂时冷却中，稍后重试' }); continue }
        const sourceSignal = AbortSignal.any([totalSignal, AbortSignal.timeout(sourceTimeoutMs)])
        const url = searchUrl(source, query, config)
        try {
          const text = await request(url, { signal: sourceSignal, proxyUrl: config.sourceProxies[source] ?? config.proxyUrl })
          sourceSignal.throwIfAborted()
          const sources = normalizedSources(parseSearchResults(source, text, url))
          if (!sources.length) throw error('empty', '没有可用结果，或搜索源要求验证')
          attempts.push({ source, ok: true })
          if (lastConfig === fingerprint) recent = attempts
          const fetchedAt = new Date(now()).toISOString()
          const result = { sources: sources.slice(0, limit), truncated: sources.length > limit, retrievedAt: fetchedAt, cacheHit: false,
            content: `来源：${source}；搜索时间：${fetchedAt}。以下为搜索摘要，尚未核对网页原文。` + (attempts.length > 1 ? '\n已按配置回退搜索源。' : '') }
          // A fallback is useful immediately, but let the preferred source recover soon.
          if (lastConfig === fingerprint) cache.set(key, { result: structuredClone(result), expires: now() + (attempts.length > 1 ? 30000 : 120000) })
          if (cache.size > 100) cache.delete(cache.keys().next().value)
          return result
        } catch (cause) {
          signal?.throwIfAborted()
          const message = sourceSignal.aborted ? '请求超时' : cause.code ? cause.message : '返回内容无法解析'
          attempts.push({ source, ok: false, error: message })
          if (lastConfig === fingerprint && ['blocked', 'rate-limit'].includes(cause.code)) cooldowns.set(source, now() + 60000)
        }
      }
      if (lastConfig === fingerprint) recent = attempts
      throw error('SEARCH_UNAVAILABLE', '搜索失败：' + attempts.map(a => a.source + '（' + a.error + '）').join('；'))
    },
    diagnostics: () => ({ attempts: structuredClone(recent) })
  }
  return provider
}
