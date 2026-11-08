import { legacyMessageUid } from '../domain/message-uid.js'

// 桥内操作只接收服务端发出的 UID；下标用于定位加速，不能成为失效身份的后备。
export function resolveStoryMessage(chat, input, { role = 'assistant', latest = false } = {}) {
  if (typeof input?.messageUid !== 'string' || !input.messageUid) throw new Error('缺少消息身份，请刷新故事页')
  const messages = chat?.messages || []
  const matches = messages.flatMap((message, position) => legacyMessageUid(message, position) === input.messageUid ? [position] : [])
  if (matches.length !== 1) throw new Error('目标消息已变化，请刷新故事页')
  const index = matches[0]
  const message = messages[index]
  if (index < 0 || message?.role !== role) throw new Error('目标消息已变化，请刷新故事页')
  if (latest && (index !== messages.length - 1 || message.greeting === true)) throw new Error('此操作只能用于最新正文')
  return { message, index, messageUid: input.messageUid }
}
