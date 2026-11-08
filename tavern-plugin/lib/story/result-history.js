import { createHash, randomUUID } from 'node:crypto'
import { foldStoryRounds } from './story-rounds.js'

// 结果只保存正文，不保存变量快照；切换后仍须按当前正文重新结算。
export function storyResultOf(message) {
  const text = String(message?.projectionText ?? message?.sourceText ?? message?.text ?? '')
  const result = { text, incomplete: message?.incomplete === true, incompleteReason: message?.incompleteReason || '' }
  return { id: createHash('sha256').update(JSON.stringify(result)).digest('hex'), ...result }
}

export function storyResultHistory(message, legacy = []) {
  const entries = Array.isArray(message?.storyResults) ? message.storyResults : legacy.map(item => ({ ...item, id: String(item.seq) }))
  const current = storyResultOf(message)
  const found = entries.find(item => item.id === message?.storyResultId)
    || (!Array.isArray(message?.storyResults) && entries.find(item => item.current === true))
    || entries.find(item => item.text === current.text && (item.incomplete === true) === current.incomplete)
  const history = entries.map(item => ({ ...item }))
  if (!found) history.push(current)
  return { history, current: found?.id || current.id }
}

export function retainStoryResults(previous, replacement) {
  const { history } = storyResultHistory(previous)
  // 每次生成都是独立结果，即使正文相同也不合并；正文指纹仅用于旧结果首次识别。
  const current = { ...storyResultOf(replacement), id: randomUUID() }
  history.push(current)
  replacement.storyResults = history
  replacement.storyResultId = current.id
  return replacement
}

// 首次升级后按当前正文核对旧原生日志，保留其中所有旧结果；只改脱离存储的源快照。
export function captureStoryResults(message, events) {
  if (!message || Array.isArray(message.storyResults)) return
  const floor = foldStoryRounds(events).floors.find(item => item.story === Number(message.turn)
    && item.reply.text === String(message.text || ''))
  const results = storyResultHistory(message, floor?.history || [])
  message.storyResults = results.history
  message.storyResultId = results.current
}
