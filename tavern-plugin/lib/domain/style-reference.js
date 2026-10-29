// Foreground style association shares the writer context. The saved reference is
// for inspection; it is not automatically injected into the next turn.

import { prompt } from '../prompt-catalog.js'
import { activeStoryTurn } from './story-tool-submission.js'

export const STYLE_REFERENCE_SUBMIT_TOOL = {
  name: 'style_reference_submit',
  description: '提交文风联想：一段笔调贴合当前场景的范文；有对应的书时附上书名、作者。提交后任务完成。',
  parameters: { type: 'object', properties: {
    book: { type: 'string', description: '书名，不带书名号；没有可不填' },
    author: { type: 'string', description: '作者；没有可不填' },
    quote: { type: 'string', description: '一段范文，约 100～300 字，不超过 400 字' }
  }, required: ['quote'], additionalProperties: false }
}

const KEPT = 8
const MAX_QUOTE = 400

function str(value) {
  return typeof value === 'string' ? value : ''
}

// Only recognized panels are removed: details may also contain actual story prose.
function stripReplyPanels(raw) {
  let text = raw.replace(/<(状态栏|status_bar|UpdateVariable|visual_cards|thinking|think)(?=[\s>])[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, '')
    .replace(/<StatusPlaceHolder(?:Impl)?\b[^>]*\/?>/gi, '')
  const stack = [], panels = []
  for (const match of text.matchAll(/<\/?details\b[^>]*>/gi)) {
    if (!/^<\//.test(match[0])) stack.push(match.index)
    else if (stack.length) {
      const start = stack.pop(), end = match.index + match[0].length
      const block = text.slice(start, end)
      const summary = block.match(/<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i)?.[1] || ''
      if (/状态|属性|面板|库存|物品栏|status|stats|inventory/i.test(summary)) panels.push([start, end])
    }
  }
  let end = 0, result = ''
  for (const [start, stop] of panels.sort((a, b) => a[0] - b[0])) {
    if (start < end) continue
    result += text.slice(end, start)
    end = stop
  }
  return (result + text.slice(end)).replace(/(?:[ \t]*\r?\n){3,}/g, '\n\n').trim()
}

export function styleReferenceReplyText(value) {
  const raw = str(value).trim()
  const text = stripReplyPanels(raw) || raw
  const limit = 6000, head = 4000, separator = '\n……\n'
  return text.length <= limit ? text : text.slice(0, head) + separator + text.slice(-(limit - head - separator.length))
}

export function readStyleReference(args) {
  const book = str(args?.book).trim().replace(/^《|》$/g, '')
  const author = str(args?.author).trim()
  const quote = str(args?.quote).trim()
  if (!quote) throw new Error('范文不能为空')
  if (quote.length > MAX_QUOTE) throw new Error('范文不超过 ' + MAX_QUOTE + ' 字，只写一段')
  return { book, author, quote }
}

/** 「《书名》作者」; empty for a passage saved without a book. */
export function styleReferenceSource(reference) {
  const book = str(reference?.book)
  return book ? '《' + book + '》' + str(reference?.author) : ''
}

function replyTurn(message) {
  return Number(message?.turn) || 0
}

/**
 * The reference recalled from the reply this turn follows. Keyed by that reply, not by turn
 * numbers: a regenerated turn gets a new native turn, but once its old reply is rolled back
 * the reply before it is again the latest, so it finds its own reference.
 */
export function styleReferenceFor(chat) {
  if (chat?.backgroundTasks?.styleReference !== true) return null
  const previous = (chat.messages || []).findLast(message => message?.role === 'assistant')
  if (!previous) return null
  const list = Array.isArray(chat.styleReferences) ? chat.styleReferences : []
  return list.findLast(item => item && Number(item.afterTurn) === replyTurn(previous)) || null
}

export function latestStyleReference(chat) {
  if (chat?.backgroundTasks?.styleReference !== true) return null
  const list = Array.isArray(chat.styleReferences) ? chat.styleReferences : []
  const item = list.at(-1)
  return item ? { book: item.book, author: item.author, quote: item.quote, afterTurn: item.afterTurn } : null
}

export function rememberStyleReference(list, reference, afterTurn) {
  const kept = (Array.isArray(list) ? list : []).filter(item => item && Number(item.afterTurn) < afterTurn)
  return [...kept, { ...reference, afterTurn }].slice(-KEPT)
}

// The guidance a player gives when asking for another passage; the passage it replaces is named
// so the model does not pick it again.
function retryText(guidance, replaced) {
  const lines = []
  if (replaced) lines.push(styleReferenceSource(replaced)
    ? `【上一次选的是${styleReferenceSource(replaced)}，这次换一段】`
    : '【上一次的范文如下，这次换一段不同的】\n' + str(replaced.quote))
  if (str(guidance).trim()) lines.push('【玩家对选段的要求，优先遵循】\n' + str(guidance).trim())
  return lines.length ? '\n\n' + lines.join('\n') : ''
}

/**
 * Recall a reference from a reply. `base: 'latest'` (after each reply) serves the next turn;
 * `base: 'previous'` re-recalls for the latest turn before it is regenerated.
 */
export function createStyleReferenceRecall({ runAgent, selection, beginTask, systemPrompt = () => prompt('style-reference-recall') }) {
  return async ({ chat, signal, base = 'latest', guidance = '', retry = false }) => {
    const replies = (chat.messages || []).filter(message => message?.role === 'assistant')
    const latest = base === 'previous' ? replies.at(-2) : replies.at(-1)
    if (!latest) {
      if (base === 'previous') throw new Error('这一轮之前没有可依据的回复')
      return null
    }
    if (!retry && latest.greeting === true) return null
    const afterTurn = replyTurn(latest)
    const replaced = retry ? (chat.styleReferences || []).findLast(item => item && Number(item.afterTurn) === afterTurn) : null
    let submitted
    const taskRun = await beginTask(chat)
    let run
    try {
      run = await runAgent({
        task: 'style-reference', persistent: true, sessionId: chat.sessionId,
        persistentSessionId: taskRun.participantRequest.sessionId,
        rewindTo: taskRun.participantRequest.rewindTo,
        rewindFormatVersion: taskRun.participantRequest.formatVersion,
        onPersistentSessionReady: id => taskRun.bindSession(id, { stateOnly: true }),
        turn: afterTurn + 1,
        selection: selection(chat), webSearchEnabled: false, signal,
        backgroundTasks: { variables: false, posture: false, characterDesign: false },
        system: systemPrompt(),
        messages: [{ role: 'user', content: [{ type: 'text', text: '【刚写完的正文】\n' + styleReferenceReplyText(latest.sourceText || latest.text) + retryText(guidance, replaced) }] }],
        tools: [STYLE_REFERENCE_SUBMIT_TOOL],
        maxToolCalls: 3,
        stopToolsWhen: () => submitted !== undefined,
        acceptWithoutText: () => submitted !== undefined,
        onToolCall(call) {
          if (call.name !== STYLE_REFERENCE_SUBMIT_TOOL.name) throw new Error('本任务只允许调用 style_reference_submit')
          submitted = readStyleReference(typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments)
          return JSON.stringify({ ok: true })
        }
      })
      if (!submitted) throw new Error('文风联想 Agent 未提交结果')
      const completed = await taskRun.commit({ participant: taskRun.participant(run), stateChanged: false, headerFields: ['styleReferences'],
        apply(draft) { draft.styleReferences = rememberStyleReference(draft.styleReferences, submitted, afterTurn) } })
      if (completed.status !== 'committed') throw new Error('剧情已变化，本次文风联想已过期')
    } catch (error) {
      await taskRun.fail(run || error)
      throw error
    }
    return submitted
  }
}


export function foregroundStyleReferencePrompt(chat, selectionPrompt, writingPrompt) {
  if ((chat?.mode || 'story') !== 'story' || chat?.backgroundTasks?.styleReference !== true) return ''
  return ['【前台文风联想】', selectionPrompt, writingPrompt,
    '本轮由你结合当前玩家输入与前情，在写正文之前完成文风联想。调用 style_reference_submit 记录参考后继续生成本轮正文，不要结束回合，也不要等待后台。选段要求中的“刚写完正文”指当前场景；历史上的旧参考不是本轮必须沿用的参考。',
    chat.styleReferenceGuidance ? '【玩家选段偏好】\n' + String(chat.styleReferenceGuidance) : ''
  ].filter(Boolean).join('\n\n')
}

export function createForegroundStyleReferenceTool({ chatForSession, save, isBackground = () => false }) {
  return {
    name: STYLE_REFERENCE_SUBMIT_TOOL.name,
    description: '记录本轮前台文风参考。成功后继续写本轮正文，不结束回合、不启动后台。',
    parameters: { book: { type: 'string' }, author: { type: 'string' }, quote: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      exec.signal?.throwIfAborted()
      const session = exec.agent?.session, sessionId = session?.id
      if (!sessionId || isBackground(sessionId)) throw Error('文风联想由前台写作回合执行')
      const turn = activeStoryTurn(session), chat = await chatForSession(sessionId)
      if (!turn || !chat || chat.sessionId !== sessionId || (chat.mode || 'story') !== 'story' || chat.backgroundTasks?.styleReference !== true) throw Error('本局未开启前台文风联想，或当前没有写作回合')
      const reference = readStyleReference(args)
      exec.signal?.throwIfAborted()
      await save(chat, reference, turn)
      return JSON.stringify({ ok: true, reference, next: '参考已记录，请继续生成本轮正文。' })
    }
  }
}
