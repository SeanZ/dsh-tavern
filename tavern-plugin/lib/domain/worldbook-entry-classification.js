import { isMvuUpdateEntry } from './worldbook-recall.js'

export function hasWorldbookPreprocessingSyntax(entry = {}) {
  return /^@@/m.test(String(entry.content || '')) || /\[(?:GENERATE:|RENDER:|InitialVariables|Preprocessing)|@INJECT/.test(String(entry.content || '') + '\n' + String(entry.comment || entry.title || ''))
}

/** Conservative, execution-free classification of authoritative worldbook entries.
 * Delimiters inside comments/escapes remain dynamic: host interpretation wins.
 * Only simple built-in read macros are dependency tracked. Arbitrary EJS and
 * decorators retain the native request occasion; this is not a purity proof.
 */
export function classifyWorldbookEntry(entry = {}) {
  const body = String(entry.content ?? '')
  const ejs = /<%|%>/.test(body)
  const decorators = hasWorldbookPreprocessingSyntax(entry)
  const macros = /\{\{|\}\}/.test(body)
  const program = isMvuUpdateEntry(entry) || /\[(?:initvar|initialvariables|mvu[_ -])/i.test(String(entry.comment || entry.title || '')) || /<script\b|```\s*(?:javascript|js|typescript|ts|ejs)\b/i.test(body)
  const dynamic = ejs || decorators || macros || program
  const dependencies = []
  let nativeFallback = ejs || decorators || program
  if (macros) {
    const remainder = body.replace(/\{\{\s*(getvar|getglobalvar|hasvar|hasglobalvar)\s*::\s*([^{}:=<>!?|+]+?)\s*\}\}/gi, (_, name, key) => {
      dependencies.push({ scope: /global/i.test(name) ? 'global' : 'local', key: key.trim() })
      return ''
    }).replace(/\{\{\s*(char|user)\s*\}\}/gi, (_, name) => {
      dependencies.push({ scope: 'identity', key: name.toLowerCase() }); return ''
    })
    if (/\{\{|\}\}/.test(remainder)) nativeFallback = true
  }
  const constant = entry.constant === true
  return { kind: dynamic ? (constant ? 'dynamic-constant' : 'dynamic-conditional') : (constant ? 'static-constant' : 'static-skill'),
    dynamic, constant, dependencies, nativeFallback, occasion: nativeFallback ? 'request' : 'dependency' }
}

/** The only entries replaced by native Skills; all others stay in recall. */
export function isStaticWorldbookSkillEntry(entry = {}) {
  return entry.enabled !== false && String(entry.content || '').trim() !== '' && classifyWorldbookEntry(entry).kind === 'static-skill'
}
