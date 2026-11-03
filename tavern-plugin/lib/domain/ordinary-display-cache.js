// 只失效纯格式化结果；真实 EJS 输出及已处理标记必须保留，避免重放有状态模板。
export function invalidateOrdinaryDisplayCache(chat) {
  let cleared = 0
  for (const message of chat.messages || []) {
    if (typeof message?.tavernPluginData?.template_display?.formattingText !== 'string') continue
    delete message.tavernPluginData.template_display
    cleared++
  }
  return cleared
}
