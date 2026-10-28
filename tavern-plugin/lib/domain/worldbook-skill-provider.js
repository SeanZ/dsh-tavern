import { createHash } from 'node:crypto'
import { isMvuUpdateEntry } from './worldbook-recall.js'

const digest = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 20)
const text = value => String(value ?? '').replace(/\s+/g, ' ').trim()
const eligible = entry => entry.enabled !== false && !isMvuUpdateEntry(entry) && text(entry.content)

/** Virtual adapter for the existing native skill registry. Never writes a skill directory.
 * load must resolve ONLY the calling foreground game, not a background parent game.
 * No body cache: every native read revalidates the game's current strategy and book.
 */
export function createWorldbookSkillProvider({ load, render }) {
  const provider = 'tavern-worldbook'
  async function stateFor(lookup) {
    if (!lookup?.scope?.session?.id) return null
    const state = await load(lookup.scope)
    return state?.chat?.sessionId === lookup.scope.session.id && state.chat.worldbookStrategy === 'native-skills' ? state : null
  }
  function candidate(state, entry) {
    const sessionId = state.chat.sessionId
    const title = text(entry.title || entry.comment || `世界书条目 ${entry.sourceUid ?? entry.ref}`).slice(0, 160)
    const keys = [...(entry.primaryKeys || []), ...(entry.secondaryKeys || [])].map(text).filter(Boolean).join('、').slice(0, 220)
    return {
      name: `wb-${digest(sessionId)}-${digest(entry.ref)}`,
      description: `本局世界书：${title}${keys ? '；相关主题：' + keys : ''}。${entry.constant ? '常驻条目已自动加载，仍可按需重读。' : '涉及该背景、地点或规则时，先用 skill 核实再叙述，勿臆造。'}`,
      invocation: { modelInvocable: true, userInvocable: false }, source: 'tavern-worldbook', provider, rank: 600,
      locator: { sessionId, ref: entry.ref },
      resourceBase: { kind: 'opaque', description: `当前局世界书 ${text(state.worldBook.view.displayName)} / ${entry.ref}` },
      metadata: { worldbook: { ref: entry.ref, sourceUid: entry.sourceUid, sourcePath: entry.sourcePath, title, book: state.worldBook.view.displayName } }
    }
  }
  const catalogs = new WeakMap()
  return {
    name: provider,
    // Native catalogs are cached. Invalidate only when this agent's metadata
    // changes, not on unrelated/background steps or body-only edits.
    async refresh(scope) {
      if (!scope || typeof scope !== 'object') return false
      const state = await stateFor({ scope })
      const catalog = state ? (state.worldBook?.view?.entries || []).filter(eligible).map(entry => candidate(state, entry)) : []
      const version = JSON.stringify(catalog)
      const previous = catalogs.get(scope)
      catalogs.set(scope, version)
      return previous === undefined ? catalog.length > 0 : previous !== version
    },
    async list(lookup) {
      const state = await stateFor(lookup)
      return { candidates: state ? (state.worldBook?.view?.entries || []).filter(eligible).map(entry => candidate(state, entry)) : [], complete: true }
    },
    async get(previous, lookup) {
      const state = await stateFor(lookup)
      if (!state || previous.locator?.sessionId !== state.chat.sessionId) return undefined
      const entry = state.worldBook?.view?.entries?.find(entry => entry.ref === previous.locator?.ref)
      if (!entry || !eligible(entry)) return undefined
      const current = candidate(state, entry)
      if (current.name !== previous.name) return undefined
      const version = JSON.stringify(entry)
      const content = await render(state, entry)
      // Rendering can await the template host while the player edits/switches.
      // Never deliver an in-flight body whose authorization or source changed.
      const latest = await stateFor(lookup)
      const latestEntry = latest?.worldBook?.view?.entries?.find(item => item.ref === entry.ref)
      if (!latestEntry || !eligible(latestEntry) || JSON.stringify(latestEntry) !== version) return undefined
      if (!String(content || '').trim()) return undefined
      return { ...current, content: `【本局世界书：${text(entry.title || entry.comment)} · ${entry.ref} · ID ${entry.sourceUid ?? entry.ref}】\n${content}` }
    }
  }
}
