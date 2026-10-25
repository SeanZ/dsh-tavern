// Story floor snapshots (fork contract C3): the static HTML a floor showed when it left the
// live iframe window, so an older floor or a cold open renders without running its
// scripts. A snapshot is a regenerable display cache, like the display-runtime capture:
// it lives beside the versioned save (one file per floor), never in it, so writing one
// adds no save revision, no merge conflict with story writes and no view refresh. Games
// without snapshots (every save before this) simply read none.
//
// Each snapshot names the reply it was taken from (`reply`, the caller's identity of
// that reply — the story view uses its reply seq). A reader compares it with the reply
// it shows now and ignores a stale one; a regenerated or switched floor overwrites it.
// 本局正则覆盖（chat.regexOverrides）变化时整档快照作废：覆盖改变渲染但不改回复 seq。
export const FLOOR_SNAPSHOT_VERSION = 1
export const FLOOR_SNAPSHOT_HTML_LIMIT = 512 * 1024
const MAX_FLOORS = 200
const REPLY_LIMIT = 200

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}
function storyTurn(value) {
  const turn = Number(value)
  if (!Number.isSafeInteger(turn) || turn < 1) throw new Error('楼层轮次无效')
  return turn
}
function meta(record) {
  return { turn: record.turn, reply: record.reply, truncated: record.truncated === true, capturedAt: record.capturedAt }
}
function valid(record, turn) {
  return record && record.version === FLOOR_SNAPSHOT_VERSION && record.turn === turn && typeof record.reply === 'string' && typeof record.html === 'string'
}

export function createFloorSnapshots({ store, chatIdFor, now = Date.now }) {
  const tails = new Map()
  const dirOf = chatId => 'floor-snapshots/' + str(chatId).replace(/[^a-zA-Z0-9_-]/g, '_')
  const pathOf = (chatId, turn) => dirOf(chatId) + '/' + turn + '.json'
  function serialize(chatId, operation) {
    const next = (tails.get(chatId) || Promise.resolve()).then(operation, operation)
    const tail = next.catch(() => {})
    tails.set(chatId, tail)
    tail.then(() => { if (tails.get(chatId) === tail) tails.delete(chatId) })
    return next
  }
  async function chatOf(sessionId) {
    const chatId = await chatIdFor(str(sessionId))
    if (!chatId) throw new Error('找不到当前存档')
    return chatId
  }
  async function readOne(chatId, turn) {
    const record = await store.readJson(pathOf(chatId, turn)).catch(() => undefined)
    return valid(record, turn) ? record : null
  }
  async function storedTurns(chatId) {
    return (await store.list(dirOf(chatId))).filter(entry => !entry.directory && /^\d+\.json$/.test(entry.name))
      .map(entry => Number(entry.name.slice(0, -5))).filter(turn => turn > 0).sort((a, b) => a - b)
  }

  /** Store one floor's snapshot; the same content again is not rewritten. */
  async function save(input = {}) {
    const chatId = await chatOf(input.sessionId)
    const turn = storyTurn(input.turn)
    const reply = str(input.reply).trim()
    if (reply === '' || reply.length > REPLY_LIMIT) throw new Error('快照缺少来源回复标识')
    if (typeof input.html !== 'string') throw new Error('快照内容必须是 HTML 文本')
    if (input.html.length > FLOOR_SNAPSHOT_HTML_LIMIT) throw new Error('快照超过 ' + FLOOR_SNAPSHOT_HTML_LIMIT / 1024 + ' KB，请截断后标记 truncated')
    if (input.truncated !== undefined && typeof input.truncated !== 'boolean') throw new Error('截断标记必须是布尔值')
    const truncated = input.truncated === true
    return await serialize(chatId, async () => {
      const current = await readOne(chatId, turn)
      if (current && current.reply === reply && current.html === input.html && current.truncated === truncated) {
        return { saved: false, snapshot: meta(current) }
      }
      const record = { version: FLOOR_SNAPSHOT_VERSION, turn, reply, html: input.html, truncated, capturedAt: now() }
      await store.writeJson(pathOf(chatId, turn), record)
      // Only the latest floors are ever shown from a snapshot before they load; drop the oldest.
      const turns = await storedTurns(chatId)
      for (const old of turns.slice(0, Math.max(0, turns.length - MAX_FLOORS))) await store.remove(pathOf(chatId, old))
      return { saved: true, snapshot: meta(record) }
    })
  }

  /** Snapshots by story turn: the floors asked for, or every stored one. */
  async function read(input = {}) {
    const chatId = await chatOf(input.sessionId)
    const turns = Array.isArray(input.turns) ? [...new Set(input.turns.map(storyTurn))].slice(0, MAX_FLOORS) : await storedTurns(chatId)
    const snapshots = {}
    for (const turn of turns) {
      const record = await readOne(chatId, turn)
      if (record) snapshots[turn] = { ...meta(record), html: record.html }
    }
    return { snapshots }
  }

  /** A forked game starts with the source's snapshots of the floors it keeps (turn ≤ maxTurn). */
  async function copyChat(fromChatId, toChatId, maxTurn) {
    return serialize(toChatId, async () => {
      let copied = 0
      for (const turn of await storedTurns(fromChatId)) {
        if (turn > maxTurn) continue
        const record = await readOne(fromChatId, turn)
        if (record) { await store.writeJson(pathOf(toChatId, turn), record); copied++ }
      }
      return copied
    })
  }

  async function removeChat(chatId) {
    return serialize(chatId, async () => {
      for (const turn of await storedTurns(chatId)) await store.remove(pathOf(chatId, turn))
    })
  }

  return Object.freeze({ save, read, copyChat, removeChat })
}
