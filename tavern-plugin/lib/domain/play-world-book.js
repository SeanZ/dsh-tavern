import { projectAgentContent } from './runtime-content-projection.js'
import { historyScanDepth } from './worldbook-activation.js'
import { isMvuUpdateEntry, isWorldBookTemplateEntry, projectWorldBookTemplates } from './worldbook-recall.js'
import { withPluginWorldbookEntries } from './plugin-worldbook.js'

// The world book a game plays with, as the background and recall read it.
export function createPlayWorldBook({ worldBooks, readChatCard, pluginApi, runtime, globalVariables = async () => ({}) }) {
  async function mvuUpdateRules(chat, card, target) {
    const worldBook = await worldBooks.bound(chat.cardPath, card, chat)
    const entries = (worldBook?.view?.entries || []).filter(entry => entry.enabled !== false && isMvuUpdateEntry(entry) && entry.content?.trim())
    if (!entries.some(isWorldBookTemplateEntry)) {
      return entries.map(entry => projectAgentContent(entry.content, { charName: card?.name, macroState: chat.macroState }).agentText).filter(Boolean)
    }
    // Render only settlement rules in a read-only projection. Never run ordinary
    // worldbook controllers again or send failed templates to the model as code.
    const projected = await projectWorldBookTemplates({ worldBook, selectedEntries: entries,
      mvuUpdateOnly: true, includeConstants: true, runtime: await runtime(chat.sessionId),
      globalVariables: await globalVariables(), chat, card, messageVariables: target?.variables })
    if (projected.diagnostics.length) throw new Error('MVU 更新规则模板执行失败：' + projected.diagnostics.map(item => item.ref + ' (' + item.code + ')').join('、'))
    return projected.renderedEntries.map(entry => entry.text)
  }
  // An unreadable book has no known depth: callers then use the complete read.
  async function worldBookScanDepth(chat) {
    try { return historyScanDepth(await worldBooks.bound(chat.cardPath, await readChatCard(chat), chat)) }
    catch { return Infinity }
  }
  // What recall, world book search and screening read: the bound book plus plugin entries (tavern.worldbookEntries).
  async function playWorldBook(chat, card) {
    const record = await worldBooks.bound(chat.cardPath, card, chat)
    if (!chat?.sessionId) return record
    const turn = Number([...(chat.messages || [])].reverse().find(message => message?.role === 'assistant')?.turn) || 0
    return withPluginWorldbookEntries(record, await pluginApi.worldbookPoolEntries({ gameId: chat.sessionId, turn }))
  }

  return { playWorldBook, worldBookScanDepth, mvuUpdateRules }
}
