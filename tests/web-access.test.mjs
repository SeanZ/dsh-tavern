import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createWebSearch, createSearchTransport } from '../tavern-plugin/lib/domain/web-search.js'
import { readWebAccess, validateWebAccess } from '../tavern-plugin/lib/domain/web-access-settings.js'
import { extractWebText, normalizedSources, parseSearchResults } from '../tavern-plugin/lib/domain/web-content.js'
import { createWebReader } from '../tavern-plugin/lib/tools/web-access.js'
import { applyTavernSettingsPatch, presentTavernSettings } from '../tavern-plugin/lib/domain/tavern-settings.js'

const rss = '<rss><channel><item><title>作品资料</title><link>https://example.com/work?utm_source=bing</link><description>搜索摘要</description></item></channel></rss>'
const html = '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fwork">作品</a><div class="result__snippet">资料摘要</div></div>'

test('搜索配置无预置代理/公共实例，保存验证并保留兄弟字段', () => {
  const defaults = readWebAccess()
  assert.equal(defaults.proxyUrl, '')
  assert.equal(defaults.searxngUrl, '')
  assert.equal(defaults.fetchEnabled, false)
  const saved = applyTavernSettingsPatch({ webAccess: { ...defaults, sources: ['ddg'] }, untouched: 1 }, { webAccess: { fetchEnabled: true } })
  assert.equal(saved.untouched, 1)
  assert.deepEqual(presentTavernSettings(saved, {}).webAccess.sources, ['ddg'])
  for (const bad of [{ sources: [] }, { sources: ['bad'] }, { sources: ['searxng'] }, { proxyUrl: 'socks5://localhost:9' }, { proxyUrl: 'http://user:password@localhost:9' }, { fetchEnabled: 'true' }, { searxngEngines: ['a,b'] }]) assert.throws(() => validateWebAccess(bad), /联网资料设置无效/)
})

test('三种搜索源解析、URL去重与跳转链接规范化', () => {
  assert.equal(parseSearchResults('bing', rss)[0].title, '作品资料')
  assert.equal(parseSearchResults('ddg', html, 'https://html.duckduckgo.com/html/')[0].url, 'https://example.com/work')
  const rows = parseSearchResults('searxng', JSON.stringify({ results: [{ url: 'https://example.com/work#x', title: '<b>作品</b>', content: '摘要' }] }))
  assert.equal(normalizedSources([...parseSearchResults('bing', rss), ...rows, { url: 'javascript:evil()' }]).length, 1)
})

test('搜索失败回退、缓存保留时间，配置变化清缓存，429冷却并可恢复', async () => {
  let config = readWebAccess(), now = 1_000_000, calls = [], blocked = true
  const search = createWebSearch({ getConfig: () => config, now: () => now, request: async (url, options) => {
    calls.push({ url, proxy: options.proxyUrl })
    if (url.includes('bing.com')) { if (blocked) throw Object.assign(new Error('HTTP 429'), { code: 'rate-limit' }); return rss }
    return html
  } })
  const result = await search.search({ query: '作品' })
  assert.equal(calls.length, 2)
  assert.match(result.content, /ddg.*搜索时间/)
  assert.match(result.content, /尚未核对网页原文/)
  const cached = await search.search({ query: '作品' })
  assert.equal(calls.length, 2)
  assert.match(cached.content, /短期缓存命中/)
  now += 31000
  await search.search({ query: '作品' })
  assert.equal(calls.length, 3, '冷却中的 Bing 被跳过')
  blocked = false; now += 61000
  assert.match((await search.search({ query: '新作品' })).content, /bing/)
  config = { ...config, proxyUrl: 'http://localhost:7890', sourceProxies: { bing: '' } }
  await search.search({ query: '作品' })
  assert.equal(calls.at(-1).proxy, '', '显式空覆盖强制直连')
})

test('取消不继续回退，源超时可回退，整次搜索受总预算限制', async () => {
  let calls = 0
  const controller = new AbortController()
  const cancelled = createWebSearch({ getConfig: readWebAccess, request: async () => { calls++; controller.abort(); throw controller.signal.reason } })
  await assert.rejects(cancelled.search({ query: 'x' }, controller.signal), { name: 'AbortError' })
  assert.equal(calls, 1)
  const search = createWebSearch({ getConfig: readWebAccess, sourceTimeoutMs: 10, timeoutMs: 100, request: async (url, { signal }) => {
    if (!url.includes('bing.com')) return html
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  // AbortSignal.timeout's timer is unref'ed; keep the test alive while awaiting it.
  const keepAlive = setInterval(() => {}, 1000)
  try {
    assert.match((await search.search({ query: 'x' })).content, /ddg/)
    const limited = createWebSearch({ getConfig: readWebAccess, timeoutMs: 5, request: async (_url, { signal }) => {
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    } })
    await assert.rejects(limited.search({ query: 'x' }), /请求超时/)
    assert.equal(limited.diagnostics().attempts.length, 1)
  } finally { clearInterval(keepAlive) }
})

test('真实 HTTP transport 限制响应大小、拒绝重定向、传递取消', async t => {
  const server = createServer((req, res) => {
    if (req.url === '/large') { res.end('x'.repeat(1_000_001)); return }
    if (req.url === '/redirect') { res.writeHead(302, { location: '/ok' }); res.end(); return }
    res.end(rss)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const transport = createSearchTransport()
  t.after(() => { transport.dispose(); server.closeAllConnections(); server.close() })
  const base = 'http://127.0.0.1:' + server.address().port
  assert.equal(await transport.request(base + '/ok', {}), rss)
  await assert.rejects(transport.request(base + '/large', {}), /1 MB/)
  await assert.rejects(transport.request(base + '/redirect', {}), /连接失败/)
  await assert.rejects(transport.request(base + '/ok', { signal: AbortSignal.abort() }), { name: 'AbortError' })
})

test('网页正文去除导航脚本，出处/时间/截断准确，错误状态不作为正文', async () => {
  const result = { url: 'https://example.com/final', statusCode: 200, cacheHit: false, body: { kind: 'html', content: '<title>作品</title><nav>菜单</nav><article><p>设定正文</p><script>throw new Error("never run")</script><p>' + '长'.repeat(21000) + '</p></article>' }, truncated: false }
  const text = extractWebText(result)
  assert.equal(text.title, '作品'); assert.equal(text.content.length, 20000); assert.equal(text.truncated, true)
  assert.doesNotMatch(text.content, /菜单|never run/)
  const read = createWebReader({ fetchPage: async () => result, now: () => 0 })
  const output = await read('https://example.com')
  assert.match(output.report, /https:\/\/example.com\/final/)
  assert.match(output.report, /1970-01-01T00:00:00.000Z/)
  assert.match(output.report, /未使用缓存；正文已截断/)
  const bad = createWebReader({ fetchPage: async () => ({ ...result, statusCode: 403 }) })
  await assert.rejects(bad('https://example.com'), /HTTP 403/)
  await assert.rejects(read('file:///etc/passwd'), /HTTP\(S\)/)
})

test('切换搜索配置时，旧请求晚到的结果不会污染新配置的缓存', async () => {
  let config = { sources: ['bing'] }, release, calls = 0
  const gate = new Promise(resolve => { release = resolve })
  const search = createWebSearch({ getConfig: () => config, request: async url => {
    calls++
    if (url.includes('bing.com')) { await gate; return rss }
    return html
  } })
  const old = search.search({ query: '作品' })
  config = { sources: ['ddg'] }
  const fresh = await search.search({ query: '作品' })
  assert.match(fresh.content, /ddg/)
  release(); await old
  assert.match((await search.search({ query: '作品' })).content, /ddg/)
  assert.equal(calls, 2)
  assert.equal(search.diagnostics().attempts[0].source, 'ddg')
})
