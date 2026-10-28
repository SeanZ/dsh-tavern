import { JSDOM } from 'jsdom'

// Scripts and subresources never run. Bound the input before allocating a DOM.
export function webDocument(text, contentType = 'text/html') {
  return new JSDOM(String(text).slice(0, 1_000_000), { contentType })
}
export function extractWebText(result, maxChars = 20000) {
  const raw = String(result.body?.content || '')
  let title = '', content = raw
  if (result.body?.kind === 'html') {
    const dom = webDocument(raw)
    try {
      const doc = dom.window.document
      title = (doc.title || '').trim().slice(0, 250)
      doc.querySelectorAll('script,style,noscript,nav,header,footer,aside,form,iframe,svg,[hidden]').forEach(node => node.remove())
      const root = doc.querySelector('article') || doc.querySelector('main') || doc.body
      root.querySelectorAll('p,div,section,li,h1,h2,h3,h4,br,tr').forEach(node => { node.prepend('\n'); node.append('\n') })
      content = root.textContent || ''
    } finally { dom.window.close() }
  }
  content = content.replace(/[\t \u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return { title, content: content.slice(0, maxChars), truncated: result.truncated === true || raw.length > 1_000_000 || content.length > maxChars }
}

export function parseSearchResults(source, text, baseUrl) {
  if (source === 'searxng') {
    const data = JSON.parse(text)
    if (!Array.isArray(data.results)) throw new Error('搜索源返回格式无效')
    return data.results.map(item => ({ url: item.url, title: item.title, snippet: item.content }))
  }
  const dom = webDocument(text, source === 'bing' ? 'text/xml' : 'text/html')
  try {
    const doc = dom.window.document
    if (source === 'bing') return [...doc.querySelectorAll('item')].map(node => ({
      url: node.querySelector('link')?.textContent, title: node.querySelector('title')?.textContent, snippet: node.querySelector('description')?.textContent
    }))
    return [...doc.querySelectorAll('.result')].map(node => {
      const link = node.querySelector('.result__a')
      let target = link?.getAttribute('href')
      if (target) {
        const parsed = new URL(target, baseUrl)
        target = parsed.hostname.endsWith('duckduckgo.com') ? parsed.searchParams.get('uddg') || parsed.href : parsed.href
      }
      return { url: target, title: link?.textContent, snippet: node.querySelector('.result__snippet')?.textContent }
    })
  } finally { dom.window.close() }
}
export function normalizedSources(rows) {
  const seen = new Set(), result = []
  for (const row of rows) {
    let url
    try { url = new URL(row.url) } catch { continue }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue
    url.hash = ''
    for (const name of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(name)) url.searchParams.delete(name)
    if (seen.has(url.href)) continue
    seen.add(url.href)
    const clean = (value, max) => String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max)
    result.push({ url: url.href, title: clean(row.title, 250), snippet: clean(row.snippet, 1500) })
  }
  return result
}
