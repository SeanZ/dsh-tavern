import { CAST_DATA_OWNER, CAST_SUBMIT_TOOL, CAST_SUBMIT_TOOL_NAME, carryCastLines, castSettlementText, dialogueQuotes, normalizeCastSubmission, recentSpeakers } from './cast-annotation.js'

/**
 * Dialogue annotation as part of the background settlement. Tavern's own counterpart
 * of a plugin settlement tool: the tool stays in the cached prefix, the per-turn note
 * says whether to use it. Results live in the per-game turn data store, bound to the
 * story text version, so rollback and regeneration need no synchronization. An edit of the
 * reply (the player's, 精修, a plugin's) carries the annotation over to the edited version.
 */
export function createCastPresentation({ enabled, turns, data, publish = () => {} }) {
  // The quotes numbered in this turn's note, so a submission maps back to text.
  const pending = new Map()
  const keyOf = (gameId, turn) => gameId + '\u0000' + turn

  async function records(chatId, turn) {
    return data.turnsUpTo({ chatId, owner: CAST_DATA_OWNER, turn })
  }

  const settlement = Object.freeze({
    tools: () => [CAST_SUBMIT_TOOL],
    has: name => name === CAST_SUBMIT_TOOL_NAME,
    /** Whether settlement must run for this game even with posture and variables off. */
    wanted: async ({ gameId } = {}) => await enabled(gameId) === true,
    async section({ gameId, turn }) {
      pending.delete(keyOf(gameId, turn))
      if (await enabled(gameId) !== true) return ''
      const material = await turns.readPendingTurn(gameId)
      if (!material || material.turn !== turn || material.greeting) return ''
      const quotes = dialogueQuotes(material.text)
      if (!quotes.length) return ''
      pending.set(keyOf(gameId, turn), { chatId: material.chatId, key: material.key, quotes })
      return castSettlementText(quotes, { speakers: recentSpeakers(await records(material.chatId, turn - 1)) })
    },
    async call(name, args, { gameId, turn }) {
      const target = pending.get(keyOf(gameId, turn))
      if (name !== CAST_SUBMIT_TOOL_NAME || !target) return JSON.stringify({ ok: false, retryable: false, error: '本轮没有需要标注的台词，不要调用 cast_submit' })
      let lines
      try { lines = normalizeCastSubmission(args, target.quotes) }
      catch (error) { return JSON.stringify({ ok: false, retryable: true, error: String(error?.message || error) }) }
      await data.saveTurn({ chatId: target.chatId, owner: CAST_DATA_OWNER, turn, key: target.key, data: { version: 1, lines } })
      pending.delete(keyOf(gameId, turn))
      publish(gameId, { turn, textVersion: target.key, lines })
      return JSON.stringify({ ok: true, annotated: lines.length })
    }
  })

  /** Annotations of the shown text versions of some turns; turns without one are left out. */
  async function forTurns(sessionId, wanted) {
    if (await enabled(sessionId) !== true) return { enabled: false, turns: {} }
    const game = await turns.resolveGame(sessionId)
    const list = [...new Set((Array.isArray(wanted) ? wanted : []).map(Number).filter(turn => Number.isSafeInteger(turn) && turn > 0))].slice(0, 100)
    if (!game || !list.length) return { enabled: true, turns: {} }
    const all = await records(game.chatId, Math.max(...list))
    const result = {}
    for (const turn of list) {
      const candidates = all.filter(item => item.turn === turn)
      if (!candidates.length) continue
      const key = await turns.currentKey(game.sessionId, turn)
      const record = key && candidates.find(item => item.key === key)
      const lines = record ? record.data?.lines : key && await carriedFrom(game, turn, key, candidates)
      if (Array.isArray(lines) && lines.length) result[turn] = lines
    }
    return { enabled: true, turns: result }
  }

  // A turn edited before edits carried their annotation (or by a path that skips it): rebuild the
  // shown version's lines from the earlier version sharing the most quotes, when at least a third of
  // the shown quotes are word for word there (a regenerated text shares almost none). A version
  // waiting for settlement (a fresh regeneration) is left to settlement.
  async function carriedFrom(game, turn, key, candidates) {
    const material = typeof turns.readTurn === 'function' ? await turns.readTurn(game.sessionId, turn).catch(() => null) : null
    if (!material || material.key !== key) return null
    const quotes = dialogueQuotes(material.text)
    if (!quotes.length) return null
    let source = null, shared = 0
    for (const item of candidates) {
      const lines = Array.isArray(item.data?.lines) ? item.data.lines : []
      const count = new Set(lines.filter(line => quotes.includes(line.quote)).map(line => line.quote)).size
      if (count > shared) { source = lines; shared = count }
    }
    if (!source || shared * 3 < quotes.length) return null
    // The old quote count is known when every quote was annotated.
    const highest = Math.max(...source.map(line => line.n))
    const lines = carryCastLines(source, source.length === highest ? highest : -1, quotes)
    if (!lines.length) return null
    await data.saveTurn({ chatId: game.chatId, owner: CAST_DATA_OWNER, turn, key, data: { version: 1, lines } }).catch(() => {})
    return lines
  }

  /** One turn's annotation for the text version shown now, whether or not annotating is on. */
  async function annotation(sessionId, turn) {
    const game = await turns.resolveGame(sessionId)
    const key = game && await turns.currentKey(game.sessionId, turn)
    if (!key) return null
    const record = (await records(game.chatId, turn)).find(item => item.turn === turn && item.key === key)
    const lines = record?.data?.lines
    return Array.isArray(lines) && lines.length ? { turn, textVersion: key, lines: structuredClone(lines) } : null
  }

  /**
   * Before an edit of the latest reply: read the shown version's annotation; the returned function,
   * called once the edit is saved, copies it onto the edited version. Never throws: speakers are a nicety.
   */
  async function beforeEdit(sessionId) {
    try {
      const before = await turns.readTurn(sessionId)
      if (!before) return async () => {}
      const turn = before.turn
      const record = (await records(before.chatId, turn)).find(item => item.turn === turn && item.key === before.key)
      if (!Array.isArray(record?.data?.lines) || !record.data.lines.length) return async () => {}
      const oldQuoteCount = dialogueQuotes(before.text).length
      return async () => {
        try {
          const after = await turns.readTurn(sessionId, turn)
          if (!after || after.key === before.key) return
          if ((await records(after.chatId, turn)).some(item => item.turn === turn && item.key === after.key)) return
          const lines = carryCastLines(record.data.lines, oldQuoteCount, dialogueQuotes(after.text))
          if (!lines.length) return
          await data.saveTurn({ chatId: after.chatId, owner: CAST_DATA_OWNER, turn, key: after.key, data: { version: 1, lines } })
          publish(after.sessionId, { turn, textVersion: after.key, lines })
        } catch (error) { console.warn('dsh-tavern: 编辑后保留台词标注失败', error) }
      }
    } catch (error) {
      console.warn('dsh-tavern: 读取台词标注失败', error)
      return async () => {}
    }
  }

  return Object.freeze({ settlement, forTurns, annotation, beforeEdit })
}
