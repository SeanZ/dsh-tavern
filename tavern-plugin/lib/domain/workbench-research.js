import { normalizedSources } from './web-content.js'
import { awaitNetwork } from './network-deadline.js'

// A bounded evidence collector, not another agent: no extra LLM, no recursive
// search, no automatic edits and no repeated paid-service fallback chain.
export function createWorkbenchResearch({ search, readPage, canFetch, now = Date.now, timeoutMs = 40000 }) {
  return async function research(input, signal) {
    if (!Array.isArray(input?.queries) || input.queries.length < 1 || input.queries.length > 3 || input.queries.some(q => typeof q !== 'string' || !q.trim() || q.length > 2000)) throw new Error('请提供 1–3 条搜索词，每条最多 2000 字')
    const queries = [...new Set(input.queries.map(q => q.trim()))]
    const deadline = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
    combined.throwIfAborted()
    const searches = [], found = []
    // Preserve query order regardless of completion order; one failed query
    // does not discard useful evidence returned by another.
    const outcomes = await Promise.allSettled(queries.map(query => awaitNetwork(Promise.resolve().then(() => search({ query, maxResults: 5 }, combined)), combined)))
    signal?.throwIfAborted()
    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i]
      if (outcome.status === 'rejected') {
        searches.push({ query: queries[i], status: 'failed', reason: combined.aborted ? '研究时间预算已用完' : '搜索失败，请查看卡片工作台搜索设置中的诊断' })
        continue
      }
      const result = outcome.value
      searches.push({ query: queries[i], status: 'ok', searchedAt: result.retrievedAt || null, cacheHit: result.cacheHit ?? null })
      found.push(...normalizedSources(result.sources || []))
    }
    if (!found.length) throw new Error('未找到可用资料，请调整搜索词或检查搜索源设置')
    const sources = normalizedSources(found)
    // Read different sites first, then fill the remaining slots. Search rank
    // remains intact inside each group; diversity is not a claim of authority.
    const hosts = new Set(), first = [], rest = []
    for (const source of sources) {
      const host = new URL(source.url).hostname
      if (hosts.has(host)) rest.push(source)
      else { hosts.add(host); first.push(source) }
    }
    const selected = first.concat(rest).slice(0, 6)
    const evidence = selected.map(source => ({ ...source, status: 'snippet_only', reason: '仅搜索摘要，尚未读取原文' }))
    for (let i = 0; i < Math.min(3, evidence.length); i++) {
      signal?.throwIfAborted()
      if (!canFetch()) { evidence[i].reason = '网页读取未开启，仅有搜索摘要'; continue }
      if (combined.aborted) { evidence[i].reason = '研究时间预算已用完，仅有搜索摘要'; continue }
      try {
        const page = await awaitNetwork(readPage(evidence[i].url, combined), combined)
        signal?.throwIfAborted()
        evidence[i] = { ...evidence[i], status: 'body', reason: undefined, url: page.url, title: page.title || evidence[i].title,
          body: page.content.slice(0, 6000), fetchedAt: page.fetchedAt, cacheHit: page.cacheHit,
          truncated: page.truncated || page.content.length > 6000 }
      } catch {
        signal?.throwIfAborted()
        evidence[i].reason = combined.aborted ? '研究时间预算已用完，仅有搜索摘要' : '网页读取失败，仅有搜索摘要'
      }
    }
    return { collectedAt: new Date(now()).toISOString(), searches, evidence,
      note: 'body 表示已读取网页内容，不代表内容已交叉核实；snippet_only 只有搜索摘要。引用请附来源链接，冲突与缺失需说明。' }
  }
}
