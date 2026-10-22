// The story as it stands in the save, folded from the session log alone: the player's
// inputs and the settled replies the model still sees, one floor per round, in order.
// The host keeps every event forever; rollbacks, regenerations and failed-turn cleanups
// are surface replacements over older ranges. Folding the surface the way the host does
// (append to the tail, a replacement takes the place of the range it shadows) leaves
// exactly the current story, so no save floors and no row plan are needed.
//
// Same rules as the row plan (transcript-row-plan.js): a reply's story round is its
// `source.tavernStoryTurn` when a replacement wrote it, else its own native turn; a
// player input is a `user/message` whose source kind is 'user'.
//
// Pure and self-contained: the browser bundle embeds it with `@include-domain`, so it
// imports nothing and touches no Node or DOM API.

const STORY_SETTLED_ENDS = ['completed', 'max-tokens']

function storyRoundsText(content) {
  return (Array.isArray(content) ? content : []).filter(block => block && block.type === 'text').map(block => String(block.text || '')).join('')
}
function storyRoundsRange(op) {
  return { start: op.startSeq ?? op.start, end: op.endSeq ?? op.end }
}
const storyRoundsIsReplace = event => Boolean(event && event.surfaceOp && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace')
const storyRoundsIsSurface = event => Boolean(event && (event.surfaceOp === 'append' || storyRoundsIsReplace(event)))
const storyRoundsIsPlayerInput = event => event && event.type === 'user/message' && event.data && event.data.source && event.data.source.kind === 'user'
// A regeneration attempt's input: its reply becomes the round's only through the replacement.
const storyRoundsIsRegeneration = event => {
  const source = event && event.type === 'user/message' && event.data && event.data.source
  return Boolean(source) && (source.kind === 'plugin:dsh-tavern-regen' || source.kind === 'plugin' && source.plugin === 'dsh-tavern-regen')
}
const storyRoundsIsModelReply = event => event && event.type === 'assistant/message' && event.data && event.data.message && event.data.message.source && event.data.message.source.kind === 'model'

/**
 * One game's rounds, fed its log in order (each event once; a page of later events at a
 * time is fine). `result()` returns
 *   { floors, abandoned, open, attempt }
 * floors:    [{ story, inputs: [{ seq, turn, text }], reply: { seq, turn, id, text },
 *              history: [{ seq, turn, text, current }] }]   — the opening has no inputs;
 *              history lists the model's own generations (raw text), reply is the current node
 * abandoned: [{ seq, turn, text, reason }] player inputs that are no longer story;
 *            reason is the failed turn's end kind ('error' | 'aborted' | 'interrupted')
 *            or 'rolled-back' / 'replaced'
 * open:      the running turn's surface { turn, inputs, reply, regenerating? }, or null
 * attempt: 最新生成尝试，独立保存准备阶段、已提交输入与结束错误，不影响已结算楼层；
 *          接纳前的 inputs 只取宿主为本轮认领的那条，窗口看不到其入队时为空。
 * An interrupted, failed or empty reply never makes a floor.
 */
function createStoryRoundsFold() {
  const events = new Map()
  let nodes = []
  const turnOf = new Map() // player input seq -> native turn
  const ended = new Map() // native turn -> turn/end reason kind
  const replacedBy = new Map() // seq -> the replacement that shadowed it
  const attempts = new Set() // native turns a regeneration input opened
  let queuedAttempt = false
  // 窗口内可见的 next-turn 队列：总是真实队列的前缀，窗口外入队的条目以 null 占位。
  let nextInputs = [], attempt = null, claiming = false
  let queued = [], running = null, last = -1, cached = null
  // Until the window shows a lifecycle boundary or a turn-numbered event, a message may
  // sit in the middle of a turn whose turn/start came before the window.
  let known = false
  function adopt(turn) {
    for (const input of queued) turnOf.set(input, turn)
    if (queuedAttempt) attempts.add(turn)
    queued = []; queuedAttempt = false
  }

  function shadow(event) {
    const { start, end } = storyRoundsRange(event.surfaceOp)
    let first = nodes.indexOf(start), final = nodes.indexOf(end)
    let removed
    if (first >= 0 && final >= first) removed = nodes.slice(first, final + 1)
    else {
      // A window that starts later than the range: drop what it holds of it.
      const sources = Array.isArray(event.sourceEventSeqs) ? new Set(event.sourceEventSeqs) : null
      removed = nodes.filter(seq => sources ? sources.has(seq) : seq >= start && seq <= end)
      first = removed.length ? nodes.indexOf(removed[0]) : (nodes.length && start < nodes[0] ? 0 : nodes.length)
    }
    const gone = new Set(removed)
    nodes = nodes.slice(0, first).filter(seq => !gone.has(seq)).concat([event.seq], nodes.slice(first).filter(seq => !gone.has(seq)))
    for (const seq of removed) {
      replacedBy.set(seq, event.seq)
      // An edited input stands for the one it replaced, in that turn.
      if (storyRoundsIsPlayerInput(event) && turnOf.has(seq) && !turnOf.has(event.seq)) turnOf.set(event.seq, turnOf.get(seq))
    }
    for (const seq of Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []) if (!replacedBy.has(seq)) replacedBy.set(seq, event.seq)
  }

  /** Fold events in log order; events already folded are skipped. */
  function addEvents(list) {
    for (const event of Array.isArray(list) ? list : []) {
      const seq = Number(event && event.seq)
      if (!Number.isSafeInteger(seq) || seq <= last) continue
      last = seq
      events.set(seq, event)
      cached = null
      // 输入模板在 user/message 之前运行；从原生 inbox 保存本次尝试，失败也不能丢掉反馈。
      if (event.type === 'agent/inbox/spliced' && event.data?.target === 'next-turn') {
        const data = event.data
        const inserted = (data.inserted || []).map(message => ({
          seq, text: storyRoundsText(message.content), player: message.source?.kind === 'user'
        }))
        // 下标相对真实队列；窗口没见过的前面条目补占位，已知条目才不会错位。
        while (nextInputs.length < data.start) nextInputs.push(null)
        const removed = nextInputs.splice(data.start, data.removedCount ?? 0, ...inserted)
        // 宿主在 turn/start 之后立即认领本轮那一条（不带 canceled）；取消、撤下不算认领。
        if (claiming && data.removedCount > 0 && data.outcome !== 'canceled') {
          claiming = false
          attempt = { ...attempt, inputs: removed.filter(input => input && input.player).map(({ seq, text }) => ({ seq, turn: attempt.turn, text })) }
        }
      }
      if (event.type === 'turn/start') {
        // A turn that never ended before the next began was cut off (the server stopped).
        if (running !== null && !ended.has(running)) ended.set(running, 'interrupted')
        running = Number(event.data && event.data.turn)
        attempt = { turn: running, seq, phase: 'preparing', inputs: [], accepted: false, error: '' }
        claiming = true
        known = true
        // A message queued before its turn starts (the inbox splices it in) belongs to it.
        adopt(running)
        continue
      }
      if (event.type === 'turn/end') {
        // The window began inside this turn: what came before its end belongs to it.
        if (!known) adopt(Number(event.data && event.data.turn))
        known = true
        claiming = false
        if (!attempt || attempt.turn !== Number(event.data.turn)) attempt = { turn: Number(event.data.turn), inputs: [], accepted: false }
        attempt = { ...attempt, seq, phase: String(event.data.reason?.kind || 'interrupted'), error: String(event.data.reason?.error?.message || '') }
        ended.set(Number(event.data && event.data.turn), String(event.data && event.data.reason && event.data.reason.kind || ''))
        running = null
        continue
      }
      if (!known && (event.type === 'step/start' || event.type === 'step/end' || event.type === 'assistant/message' && event.surfaceOp === 'append') && Number.isSafeInteger(Number(event.data && event.data.turn)) && Number(event.data.turn) > 0) {
        // A step of a turn whose start is outside the window: that turn is running.
        running = Number(event.data.turn)
        known = true
        adopt(running)
      }
      if (attempt && event.type === 'step/start' && Number(event.data?.turn) === attempt.turn) { attempt = { ...attempt, phase: 'generating' }; claiming = false }
      if (storyRoundsIsPlayerInput(event) && event.surfaceOp === 'append') {
        if (attempt && running === attempt.turn) {
          const input = { seq, turn: running, text: textOf(event) }
          attempt = { ...attempt, accepted: true, inputs: attempt.accepted ? [...attempt.inputs, input] : [input] }
        }
        if (running === null) queued.push(seq)
        else turnOf.set(seq, running)
      }
      if (storyRoundsIsRegeneration(event) && event.surfaceOp === 'append') {
        if (running === null) queuedAttempt = true
        else attempts.add(running)
      }
      if (!storyRoundsIsSurface(event)) continue
      if (storyRoundsIsReplace(event)) shadow(event)
      else nodes.push(seq)
    }
  }

  function textOf(event) {
    return event.type === 'user/message' ? storyRoundsText(event.data && event.data.content) : storyRoundsText(event.data && event.data.message && event.data.message.content)
  }
  function storyOf(event) {
    const story = Number(event.data && event.data.message && event.data.message.source && event.data.message.source.tavernStoryTurn)
    return Number.isSafeInteger(story) && story > 0 ? story : Number(event.data && event.data.turn)
  }
  // Every reply the round has had: the model's own generations (append replies) behind the
  // current node's replacement chain. Replacements (reply projections, regeneration
  // bodies, edits) are renderings of a generation, not results of their own: each stands
  // for the one it names (`tavernResultSeq`, written by a result switch) or else the
  // latest generation it covers.
  function historyOf(current) {
    const reachable = seq => {
      const seen = new Set(), found = []
      const visit = at => {
        if (seen.has(at)) return
        seen.add(at)
        const event = events.get(at)
        if (!event || event.type !== 'assistant/message') return
        if (!storyRoundsIsReplace(event)) { if (storyRoundsIsModelReply(event) && textOf(event) !== '') found.push(event); return }
        for (const source of Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []) visit(source)
      }
      visit(seq)
      return found.sort((a, b) => a.seq - b.seq)
    }
    const found = reachable(current.seq)
    if (!found.length) return [{ seq: current.seq, turn: Number(current.data.turn), text: textOf(current), current: true }]
    const named = Number(current.data.message.source.tavernResultSeq)
    const currentSeq = !storyRoundsIsReplace(current) ? current.seq
      : found.some(event => event.seq === named) ? named : found[found.length - 1].seq
    return found.map(event => ({ seq: event.seq, turn: Number(event.data.turn), text: textOf(event), current: event.seq === currentSeq }))
  }
  function failedEnd(turn) {
    const kind = ended.get(turn)
    return kind !== undefined && !STORY_SETTLED_ENDS.includes(kind) ? kind : ''
  }
  function abandonReason(seq, visible) {
    const failed = failedEnd(turnOf.get(seq))
    if (failed) return failed
    for (let next = replacedBy.get(seq), steps = 0; next !== undefined && steps < 1000; next = replacedBy.get(next), steps++) {
      const event = events.get(next)
      const content = event && (event.type === 'user/message' ? event.data && event.data.content : event.data && event.data.message && event.data.message.content)
      // An empty replacement is a tombstone (rollback, cleanup); a non-empty one an edit or repair.
      if (Array.isArray(content) && content.length === 0) return 'rolled-back'
      if (visible.has(next)) return ''
    }
    return visible.has(seq) ? '' : 'replaced'
  }

  function result() {
    if (cached) return cached
    const floors = [], abandoned = []
    let inputs = [], open = null
    const opened = () => (open = open || { turn: running, inputs: [], reply: null })
    for (const seq of nodes) {
      const event = events.get(seq)
      if (storyRoundsIsPlayerInput(event)) {
        const input = { seq, turn: turnOf.has(seq) ? turnOf.get(seq) : null, text: textOf(event) }
        // Queued for the next turn, or part of the one running now.
        if (input.turn === null && !storyRoundsIsReplace(event) || input.turn !== null && input.turn === running) opened().inputs.push(input)
        else if (input.turn === null || ended.has(input.turn) && !failedEnd(input.turn)) inputs.push(input)
        continue
      }
      if (!storyRoundsIsModelReply(event)) continue
      const text = textOf(event)
      if (text === '') continue
      const turn = Number(event.data.turn)
      if (turn === running) { opened().reply = { seq, turn, text }; if (attempts.has(turn)) open.regenerating = true; continue }
      if (!storyRoundsIsReplace(event) && attempts.has(turn)) continue
      // An append reply is story once its turn completed; a replacement is Tavern's own settled write.
      if (!storyRoundsIsReplace(event) && !(ended.has(turn) && !failedEnd(turn))) continue
      const story = storyOf(event)
      const reply = { seq, turn, id: String(event.data.message.id || ''), text }
      const previous = floors[floors.length - 1]
      // A later step of the same round (after a tool call) is that round's reply.
      if (!inputs.length && previous && previous.story === story) { previous.reply = reply; previous.history = historyOf(event); continue }
      floors.push({ story, inputs, reply, history: historyOf(event) })
      inputs = []
    }
    const visible = new Set(nodes)
    for (const [seq, turn] of turnOf) {
      const event = events.get(seq)
      if (storyRoundsIsReplace(event) || event.data.source.repair) continue
      const reason = abandonReason(seq, visible)
      if (reason) abandoned.push({ seq, turn, text: textOf(event), reason })
    }
    abandoned.sort((a, b) => a.seq - b.seq)
    cached = { floors, abandoned, open, attempt }
    return cached
  }

  return { addEvents, result, get folded() { return last } }
}

/** The rounds of a whole log (or a page of it) at once. */
function foldStoryRounds(events) {
  const fold = createStoryRoundsFold()
  fold.addEvents(events)
  return fold.result()
}

export { createStoryRoundsFold, foldStoryRounds }
