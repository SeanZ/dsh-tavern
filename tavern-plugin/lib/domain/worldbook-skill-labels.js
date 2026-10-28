import { pinyin } from 'pinyin-pro'

/** Extract labels, never summarize or invent facts. Statistical n-grams remain
 * clustering features only. Ambiguous groups list their actual member titles. */
export function worldbookEntryTitle(entry) {
  const clean = value => String(value || '').replace(/^\s*(?:\d+[a-z]?[_-])?(?:\[(?:mvu_[\w-]+|worldbook)\]\s*)+/i, '')
    .replace(/^\s*\d+[a-z]?_/, '').replace(/\s+/g, ' ').trim()
  const heading = String(entry.content || '').match(/^#{1,3}\s+([^\n]+)$/m)?.[1]
  return clean(entry.title || entry.comment) || clean(heading) || `条目 ${entry.sourceUid ?? entry.ref}`
}
export function worldbookTitleParts(title) {
  // Bracketed paths are explicit author categories, not fragments inferred
  // from prose. Keep unbracketed hyphenated names intact.
  const path = title.match(/^\[([^\[\]]+[-_][^\[\]]+)\]/)?.[1]
  return (path ? path.split(/[-_]/) : title.split(/[·｜|]/)).map(s => s.trim()).filter(Boolean)
}
const parts = worldbookTitleParts
const category = entry => String(entry.content || '').match(/(?:^|[\n；;：:])\s*(?:类别|分类|类型)\s*[：:=]\s*["“]?([^"”\n；;,，。]{1,20})/m)?.[1]?.trim()
const fields = entry => [...String(entry.content || '').matchAll(/^(?:[-*]\s+)?(?:\*\*)?([\p{L}][\p{L}\d ]{0,14})(?:\*\*)?\s*[：:]/gmu)].map(m => m[1].trim())
export function describeWorldbookCluster(entries) {
  const titles = [...new Set(entries.map(worldbookEntryTitle))]
  const split = titles.map(parts)
  const prefix = []
  for (let i = 0; i < split[0].length; i++) {
    if (!split.every(p => p[i] === split[0][i])) break
    prefix.push(split[0][i])
  }
  const categories = entries.map(category)
  const commonCategory = categories[0] && categories.every(c => c === categories[0]) ? categories[0] : ''
  const suffix = split.length > 1 && split.every(p => p.length > prefix.length + 1 && p.at(-1) === split[0].at(-1)) ? split[0].at(-1) : ''
  let title = titles.length === 1 ? titles[0] : prefix.join('·')
  if (titles.length > 1 && commonCategory) title = [commonCategory, ...prefix.filter(p => p !== commonCategory)].join('') + (suffix ? `·${suffix}` : '')
  if (!title) title = titles.slice(0, 2).join('、') + (titles.length > 2 ? `等${titles.length}项资料` : '')
  const subjects = split.map(p => p.slice(prefix.length, suffix ? -1 : undefined).join('·') || p.join('·'))
  const sharedFields = [...new Set(fields(entries[0]))].filter(f => entries.every(e => fields(e).includes(f))).slice(0, 5)
  const listed = subjects.slice(0, 6).join('、') + (subjects.length > 6 ? `等${subjects.length}项` : '')
  const description = `查询${title}。` + (titles.length > 1 ? `收录${listed}。` : '') + (sharedFields.length ? `原文提供${sharedFields.join('、')}。` : '按资料链接查阅原文。')
  return { title, description, keywords: [...new Set(subjects)], subjects, sharedFields }
}
export function worldbookSkillSlug(title) {
  // DSH native names accept only [a-z0-9-]. Local transliteration is deterministic
  // and performs no network/model calls. Unknown scripts fall back explicitly.
  return pinyin(title, { toneType: 'none', type: 'array' }).join('-').normalize('NFKD')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 56).replace(/-$/g, '') || 'worldbook'
}
