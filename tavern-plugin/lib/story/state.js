// 最新楼层切换历史结果后，MVU 变量尚未按当前正文重算。
// 结算或重生成会清除标记；手动编辑正文仍保留。
export function staleVariablesOf(chat) {
  const messages = Array.isArray(chat && chat.messages) ? chat.messages : []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || message.role !== 'assistant') continue
    const stale = message.variablesStale
    return stale && typeof stale === 'object'
      ? { turn: Number(message.turn), replySeq: Number(stale.replySeq) }
      : null
  }
  return null
}
