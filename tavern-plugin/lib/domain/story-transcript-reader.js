import { readRecentWindow } from './bounded-history.js'
import { projectStoryTranscript, storyReplyNativeTurns } from './story-transcript.js'
import { storyToolCalls } from './story-tool-calls.js'

const summaryOf = message => ({
  role: message?.role,
  turn: message?.turn,
  greeting: message?.greeting
})

// 只返回故事视图使用的字段；宿主锚点和其它插件数据留在服务端。
const transportFields = Object.freeze([
  'id', 'messageUid', 'role', 'tavernRole', 'tavernHidden', 'turn', 'greeting', 'text', 'displayText',
  'displayMode', 'projectionVersion', 'projectionWarnings', 'placeholder', 'swipeId',
  'storyResults', 'storyResultId', 'variablesStale', 'incomplete', 'incompleteReason'
])
function transportMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message
  const result = {}
  for (const field of transportFields) {
    if (Object.hasOwn(message, field)) result[field] = message[field]
  }
  // 输入模板和旧结果匹配用原文；与正文相同可直接沿用 text。
  if (typeof message.sourceText === 'string' && message.sourceText !== result.text) result.sourceText = message.sourceText
  if (message.role === 'user') {
    if (typeof message.source?.rpcId === 'string' && message.source.rpcId) result.source = { rpcId: message.source.rpcId }
    const display = message.tavernPluginData?.template_display
    if (typeof display?.html === 'string') result.tavernPluginData = { template_display: { source: display.source, swipe: display.swipe, html: display.html } }
  }
  // Helper/native repair rows can store their text in one of these containers.
  // Keep the fallback only when the ordinary story text fields are absent.
  if (typeof result.text !== 'string' && typeof result.displayText !== 'string') {
    if (Object.hasOwn(message, 'message')) result.message = message.message
    if (Object.hasOwn(message, 'content')) result.content = message.content
  }
  return result
}
async function projectWindow(window, summaries, readToolEvents) {
  const transcript = projectStoryTranscript(window, summaries)
  const nativeTurns = storyReplyNativeTurns(window, summaries)
  const calls = readToolEvents ? await storyToolCalls(window.chat.sessionId, nativeTurns, readToolEvents) : []
  return {
    ...transcript,
    messages: transcript.messages.map((entry, index) => ({ ...entry, message: transportMessage(entry.message),
      ...(nativeTurns[index] === null ? {} : { nativeTurn: nativeTurns[index] }),
      ...(calls[index]?.length ? { toolCalls: calls[index] } : {}) }))
  }
}

/**
 * Old Chat storage is materialized once. Paged storage uses inline floor
 * summaries pinned to the window revision. Native tool events are opt-in.
 */
export function createStoryTranscriptReader({
  readSessionMap, readWindow, readRecentSummaries, readChat,
  readToolEvents, messageFields, limit = 120
}) {
  async function fullWindow(chatId, sessionId, tools) {
    const chat = await readChat(chatId)
    if (!chat || String(chat.sessionId || '') !== String(sessionId)
      || !['story', 'script'].includes(chat.mode || 'story')
      || !Array.isArray(chat.messages)) return null
    const messageCount = chat.messages.length
    const window = {
      chat,
      from: 0,
      to: messageCount - 1,
      messageCount,
      revision: Number(chat._storageRevision) || 0
    }
    return {
      ...window,
      storyTranscript: await projectWindow(window, chat.messages.map(summaryOf), tools)
    }
  }

  return async function readStoryTranscriptWindow(sessionId, historyFrom, { includeToolCalls = false } = {}) {
    const chatId = (await readSessionMap())[String(sessionId)]
    if (!chatId) return null
    const tools = includeToolCalls ? readToolEvents : undefined
    const from = Number.isSafeInteger(historyFrom) && historyFrom >= 0 ? historyFrom : undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      const window = await readRecentWindow(readWindow, chatId, {
        limit,
        from,
        messageFields
      })
      if (!window) return fullWindow(chatId, sessionId, tools)
      if (String(window.chat?.sessionId || '') !== String(sessionId)
        || !['story', 'script'].includes(window.chat?.mode || 'story')) return null
      const summaryPage = await readRecentSummaries(chatId, window.messageCount, { revision: window.revision })
      if (summaryPage?.revision === window.revision && summaryPage.from === 0
        && summaryPage.messageCount === window.messageCount
        && Array.isArray(summaryPage.messages)) {
        return {
          ...window,
          storyTranscript: await projectWindow(window, summaryPage.messages, tools)
        }
      }
      // A write landed between the page and summary reads. Retry; the final
      // fallback is one coherent full Chat read rather than mixed revisions.
    }
    return fullWindow(chatId, sessionId, tools)
  }
}
