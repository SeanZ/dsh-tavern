export const WEB_SOURCES = ['bing', 'ddg', 'searxng']
export const defaultWebAccess = () => ({ sources: ['bing', 'ddg'], searxngUrl: '', searxngEngines: [], proxyUrl: '', sourceProxies: {}, fetchEnabled: false })
const invalid = field => { throw new Error('联网资料设置无效：' + field) }
function url(value, field, proxy = false) {
  if (typeof value !== 'string' || value.length > 2048) invalid(field)
  if (!value) return ''
  let parsed
  try { parsed = new URL(value) } catch { invalid(field) }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search || (proxy && parsed.pathname !== '/')) invalid(field)
  return parsed.href.replace(/\/$/, '')
}
export function validateWebAccess(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('配置')
  const config = { ...defaultWebAccess(), ...value }
  for (const key of Object.keys(value)) if (!(key in defaultWebAccess())) invalid(key)
  if (!Array.isArray(config.sources) || !config.sources.length || config.sources.length > 3 || config.sources.some(s => !WEB_SOURCES.includes(s))) invalid('搜索源')
  config.sources = [...new Set(config.sources)]
  config.searxngUrl = url(config.searxngUrl, 'SearXNG 地址')
  if (config.sources.includes('searxng') && !config.searxngUrl) invalid('请填写 SearXNG 地址')
  if (!Array.isArray(config.searxngEngines) || config.searxngEngines.length > 50 || config.searxngEngines.some(s => typeof s !== 'string' || !s.trim() || s.length > 80 || /[,\r\n]/.test(s))) invalid('SearXNG 引擎')
  config.searxngEngines = [...new Set(config.searxngEngines.map(s => s.trim()))]
  config.proxyUrl = url(config.proxyUrl, '搜索代理', true)
  if (!config.sourceProxies || typeof config.sourceProxies !== 'object' || Array.isArray(config.sourceProxies)) invalid('搜索源代理')
  config.sourceProxies = Object.fromEntries(Object.entries(config.sourceProxies).map(([source, value]) => {
    if (!WEB_SOURCES.includes(source)) invalid('搜索源代理')
    // An explicit empty override means direct; an absent key inherits the default.
    return [source, url(value, source + ' 代理', true)]
  }))
  if (typeof config.fetchEnabled !== 'boolean') invalid('网页读取')
  return config
}
export function readWebAccess(value) {
  try { return validateWebAccess(value ?? {}) } catch { return defaultWebAccess() }
}
