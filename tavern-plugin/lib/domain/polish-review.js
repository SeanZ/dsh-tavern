// 精修: an editor reads the latest reply against the principles and returns edits, exact
// replacements of a phrase, sentence or whole paragraphs that the player ticks and applies
// through the body editor.

const CARD_LIMIT = 6000, PREVIOUS_LIMIT = 3000, INPUT_LIMIT = 2000, GUIDANCE_LIMIT = 1000

function str(value) { return typeof value === 'string' ? value : value == null ? '' : String(value) }
function head(text, limit) { const value = str(text).trim(); return value.length > limit ? value.slice(0, limit) + '……' : value }
function tail(text, limit) { const value = str(text).trim(); return value.length > limit ? '……' + value.slice(-limit) : value }
function replyText(message) { return str(message && (message.projectionText ?? message.sourceText ?? message.text)) }

/** The player input and the reply before the latest one, read from the Chat tail. */
export function polishReviewContext(messages) {
  const rows = messages || []
  let input = '', previous = ''
  for (let index = rows.length - 2, seenUser = false; index >= 0; index -= 1) {
    const message = rows[index]
    if (!message) continue
    if (!seenUser && message.role === 'user') { input = str(message.text); seenUser = true; continue }
    if (seenUser && message.role === 'assistant') { previous = replyText(message); break }
  }
  return { input, previous }
}

export function buildPolishReviewRequest({ principles, card, playerName, input, previous, reply, guidance }) {
  const rules = str(principles).trim()
  if (rules === '') throw new Error('正文精修原则为空，请在系统提示词里填写')
  const body = str(reply).trim()
  if (body === '') throw new Error('这轮没有可精修的正文')
  const setting = ['description', 'personality', 'scenario'].map(key => str(card?.[key]).trim()).filter(Boolean).join('\n\n')
  const sections = [
    '【人物卡：' + (str(card?.name).trim() || '未命名') + '】\n' + (head(setting, CARD_LIMIT) || '（无）'),
    '【玩家角色】' + (str(playerName).trim() || '你'),
    previous.trim() ? '【上一轮正文】\n' + tail(previous, PREVIOUS_LIMIT) : '',
    input.trim() ? '【本轮玩家输入】\n' + head(input, INPUT_LIMIT) : '',
    '【本轮正文】\n' + body,
    // The player's guidance from the regeneration box rides along: it comes first, inside the same edit-list rules.
    str(guidance).trim() ? '【玩家的修改意见】\n' + head(guidance, GUIDANCE_LIMIT) + '\n\n先按这条意见改，再按审稿标准找其他问题；意见同样写成修改清单，情节走向和事件结果仍保持原样，除非意见明确要求改动。' : '',
    '请按审稿标准写出修改清单。'
  ].filter(Boolean)
  return { system: rules, messages: [{ role: 'user', content: [{ type: 'text', text: sections.join('\n\n') }] }] }
}

function occurrences(texts, find) {
  const hits = []
  texts.forEach((text, part) => { for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + 1)) hits.push({ part, at }) })
  return hits
}

/** The editor's JSON. Unreadable output comes back as text for the guidance box (guided regeneration). */
export function parsePolishReview(output, texts) {
  const raw = str(output).trim()
  const body = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let value
  try { value = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)) } catch { value = undefined }
  if (!value || typeof value !== 'object' || !Array.isArray(value.edits)) return { edits: [], fallback: raw }
  const taken = []
  const edits = value.edits.flatMap(edit => {
    const find = str(edit?.find)
    if (!find.trim()) return []
    const hits = occurrences(texts, find)
    let status = hits.length === 1 ? 'ok' : hits.length === 0 ? 'missing' : 'ambiguous'
    if (status === 'ok') {
      const { part, at } = hits[0], end = at + find.length
      // An earlier (more important) edit already covers part of this text.
      if (taken.some(range => range.part === part && range.at < end && at < range.end)) status = 'overlap'
      else taken.push({ part, at, end })
    }
    return [{ reason: str(edit?.reason).trim(), find, replace: str(edit?.replace), status }]
  })
  return { edits, fallback: '' }
}

/** Apply chosen edits to the reply's text parts; each must still match exactly once. */
export function applyPolishEdits(texts, edits) {
  const next = texts.slice()
  for (const edit of edits) {
    const find = str(edit?.find)
    const hits = find ? occurrences(next, find) : []
    if (hits.length !== 1) throw new Error('正文里找不到要改的原句，可能已经改过，请重新审稿：' + find.slice(0, 30))
    const { part, at } = hits[0]
    next[part] = next[part].slice(0, at) + str(edit.replace) + next[part].slice(at + find.length)
  }
  return next
}
