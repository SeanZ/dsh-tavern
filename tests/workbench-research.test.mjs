import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkbenchResearch } from '../tavern-plugin/lib/domain/workbench-research.js'

const source = (url, n = '') => ({ url, title: '作品' + n, snippet: '搜索摘要' + n })
const rows = [source('https://one.example/1'), source('https://one.example/2'), source('https://two.example/1'), source('https://three.example/1'), source('https://four.example/1')]

test('工作台证据包优先不同站点，最多三页，原文/摘要、抓取时间与截断状态分明', async () => {
  const calls = []
  const research = createWorkbenchResearch({ canFetch: () => true, now: () => 0,
    search: async ({ query }) => { if (query === 'bad') throw new Error('provider detail'); return { sources: rows, retrievedAt: '2026-10-25T00:00:00.000Z', cacheHit: true } },
    readPage: async url => { calls.push(url); if (url.includes('two.example')) throw new Error('403'); return { url, title: '原文标题', content: '原'.repeat(7000), fetchedAt: '2026-10-25T01:00:00.000Z', cacheHit: false, truncated: false } }
  })
  const result = await research({ queries: ['作品', '作品', 'bad'] })
  assert.deepEqual(calls, ['https://one.example/1', 'https://two.example/1', 'https://three.example/1'])
  assert.equal(result.searches.length, 2)
  assert.equal(result.searches[0].cacheHit, true)
  assert.equal(result.searches[1].status, 'failed')
  const body = result.evidence[0]
  assert.equal(body.status, 'body'); assert.equal(body.body.length, 6000); assert.equal(body.truncated, true)
  assert.equal(body.fetchedAt, '2026-10-25T01:00:00.000Z'); assert.equal(body.cacheHit, false)
  assert.equal(result.evidence[1].status, 'snippet_only'); assert.equal(result.evidence[1].body, undefined)
  assert.equal(result.evidence[3].status, 'snippet_only')
})

test('关闭抓取仍返回可追溯摘要，执行中关闭停止后续抓取，不触发卡片修改', async () => {
  let enabled = false, reads = 0
  const research = createWorkbenchResearch({ canFetch: () => enabled, search: async () => ({ sources: rows }),
    readPage: async url => { reads++; enabled = false; return { url, content: '正文', fetchedAt: 'now', truncated: false, cacheHit: false } }
  })
  const snippets = await research({ queries: ['x'] })
  assert.equal(reads, 0); assert.ok(snippets.evidence.every(e => e.status === 'snippet_only'))
  assert.equal(snippets.searches[0].searchedAt, null, '第三方搜索无时间信息时不伪造')
  enabled = true
  const partial = await research({ queries: ['x'] })
  assert.equal(reads, 1); assert.equal(partial.evidence[0].status, 'body'); assert.equal(partial.evidence[1].status, 'snippet_only')
})

test('研究预算耗尽保留已经取得的摘要，主动取消不伪装成成功', async () => {
  const research = createWorkbenchResearch({ canFetch: () => true, timeoutMs: 10, search: async () => ({ sources: rows }),
    readPage: async (_url, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) })
  const keepAlive = setInterval(() => {}, 1000)
  try {
    const result = await research({ queries: ['x'] })
    assert.ok(result.evidence.every(e => e.status === 'snippet_only'))
    assert.match(result.evidence[0].reason, /时间预算/)
    await assert.rejects(research({ queries: ['x'] }, AbortSignal.abort()), { name: 'AbortError' })
  } finally { clearInterval(keepAlive) }
  await assert.rejects(research({ queries: [] }), /1–3/)
})

test('第三方搜索忽略取消也受总预算约束，其它来源的证据仍返回', async () => {
  const research = createWorkbenchResearch({ canFetch: () => false, timeoutMs: 10,
    search: async ({ query }) => query === 'stuck' ? new Promise(() => {}) : { sources: rows }, readPage: async () => { throw new Error('不应抓取') } })
  const keepAlive = setInterval(() => {}, 1000)
  try {
    const result = await research({ queries: ['good', 'stuck'] })
    assert.equal(result.searches[0].status, 'ok')
    assert.equal(result.searches[1].status, 'failed')
    assert.ok(result.evidence.length > 0)
  } finally { clearInterval(keepAlive) }
})
