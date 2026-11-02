// 故事楼层投影与模型上下文使用同一原生日志，但压缩摘要不替代用户可见的故事正文。
// 保留真实 Surface 的替换关系；仅在输出楼层时展开压缩节点所覆盖的原节点。
// 撤回或其它编辑若替换整个摘要，旧楼层也随之退出，不能简单忽略所有压缩事件。
// 模块由浏览器构建内嵌，不依赖 Node 或 DOM。

const STORY_SETTLED_ENDS = ['completed', 'max-tokens']

const STRAY_CHECKPOINT_FORM = 'compaction-checkpoint-rewrite'
// 服务端与浏览器共用来源识别，兼容旧日志及升级器改挂后的摘要。
function isCompactionCheckpoint(event) {
  const source = event?.type === 'user/message' ? event.data?.source : null
  if (source?.kind === 'compact-checkpoint') return true
  const producer = source?.kind === 'plugin' ? source.plugin
    : typeof source?.kind === 'string' && source.kind.startsWith('plugin:') ? source.kind.slice(7) : ''
  return producer === 'compact' || producer === 'dsh-compaction-basic'
    || producer === 'dsh-tavern' && source.form === STRAY_CHECKPOINT_FORM
}


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
const storyRoundsIsRegenerationSource = source => Boolean(source) && (source.kind === 'plugin:dsh-tavern-regen' || source.kind === 'plugin' && source.plugin === 'dsh-tavern-regen')
const storyRoundsIsRegeneration = event => Boolean(event && event.type === 'user/message' && storyRoundsIsRegenerationSource(event.data && event.data.source))
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
 *            or 'rolled-back' / 'replaced'; an aborted or interrupted turn the next turn
 *            replaced by claiming a player input (the story queue's auto interrupt, or
 *            the player sending again) is 'superseded': the player has moved on
 * open:      the running turn's surface { turn, inputs, reply, regenerating? }, or null
 * attempt: 最新生成尝试，独立保存准备阶段、已提交输入与结束错误，不影响已结算楼层；
 *          接纳前的 inputs 只取宿主为本轮认领的那条，窗口看不到其入队时为空；未接纳就出错时，
 *          准备阶段被撤下的排队玩家输入（服务端拒绝本轮时一并撤下）接在其后；
 *          重新生成的尝试轮带 regenerating: true（它的失败归楼层操作，不是玩家自己的回合）。
 * An interrupted, failed or empty reply never makes a floor.
 */
function createStoryRoundsFold() {
  const events = new Map()
  let nodes = []
  const compacted = new Map() // 压缩节点 -> 当时被覆盖的 Surface 节点，可嵌套
  const turnOf = new Map() // player input seq -> native turn
  const ended = new Map() // native turn -> turn/end reason kind
  const replacedBy = new Map() // seq -> the replacement that shadowed it
  const attempts = new Set() // native turns a regeneration input opened
  const superseded = new Set() // stopped native turns a later turn's claimed player input replaced
  let lastEnded = null // { turn, kind } of the latest turn/end
  let queuedAttempt = false
  // 窗口内可见的 next-turn 队列：总是真实队列的前缀，窗口外入队的条目以 null 占位。
  let nextInputs = [], attempt = null, claiming = false
  // 本轮准备阶段被撤下（canceled）的排队玩家输入；本轮未接纳就出错时并入 attempt.inputs。
  let dropped = []
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
    if (isCompactionCheckpoint(event)) compacted.set(event.seq, removed)
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
          seq, text: storyRoundsText(message.content), player: message.source?.kind === 'user', regenerating: storyRoundsIsRegenerationSource(message.source)
        }))
        // 下标相对真实队列；窗口没见过的前面条目补占位，已知条目才不会错位。
        while (nextInputs.length < data.start) nextInputs.push(null)
        const removed = nextInputs.splice(data.start, data.removedCount ?? 0, ...inserted)
        // 宿主在 turn/start 之后立即认领本轮那一条（不带 canceled）；取消、撤下不算认领。
        if (claiming && data.removedCount > 0 && data.outcome !== 'canceled') {
          claiming = false
          attempt = { ...attempt, inputs: removed.filter(input => input && input.player).map(({ seq, text }) => ({ seq, turn: attempt.turn, text })) }
          if (attempt.inputs.length && lastEnded && lastEnded.turn < attempt.turn && ['aborted', 'interrupted'].includes(lastEnded.kind)) superseded.add(lastEnded.turn)
          if (removed.some(input => input && input.regenerating)) attempt.regenerating = true
        } else if (attempt && attempt.phase === 'preparing' && !attempt.accepted && running === attempt.turn && data.outcome === 'canceled') {
          // 回合开始前被拒（如变量未重算）时，服务端把仍在排队的玩家输入一并撤下：文字跟本轮一起恢复。
          dropped.push(...removed.filter(input => input && input.player).map(({ seq, text }) => ({ seq, turn: attempt.turn, text })))
        }
      }
      if (event.type === 'turn/start') {
        // A turn that never ended before the next began was cut off (the server stopped).
        if (running !== null && !ended.has(running)) ended.set(running, 'interrupted')
        running = Number(event.data && event.data.turn)
        attempt = { turn: running, seq, phase: 'preparing', inputs: [], accepted: false, error: '' }
        dropped = []
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
        if (attempt.phase === 'error' && !attempt.accepted && dropped.length) attempt.inputs = [...attempt.inputs, ...dropped]
        dropped = []
        ended.set(Number(event.data && event.data.turn), String(event.data && event.data.reason && event.data.reason.kind || ''))
        lastEnded = { turn: Number(event.data && event.data.turn), kind: String(event.data?.reason?.kind || '') }
        running = null
        continue
      }
      if (!known && (event.type === 'step/start' || event.type === 'step/end' || event.type === 'assistant/message' && event.surfaceOp === 'append') && Number.isSafeInteger(Number(event.data && event.data.turn)) && Number(event.data.turn) > 0) {
        // A step of a turn whose start is outside the window: that turn is running.
        running = Number(event.data.turn)
        known = true
        adopt(running)
      }
      if (attempt && event.type === 'step/start' && Number(event.data?.turn) === attempt.turn) { attempt = { ...attempt, phase: 'generating' }; claiming = false; dropped = [] }
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
        if (attempt && running === attempt.turn && !attempt.regenerating) attempt = { ...attempt, regenerating: true }
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
      const seen = new Set(), found = [], partialTurns = new Set()
      const visit = at => {
        if (seen.has(at)) return
        seen.add(at)
        const event = events.get(at)
        if (!event || event.type !== 'assistant/message') return
        if (!storyRoundsIsReplace(event)) { if (storyRoundsIsModelReply(event) && textOf(event) !== '') found.push(event); return }
        // 已接纳的部分正文以落盘投影作为独立结果；attempt 本身不进入可见楼层。
        if (event.data.message.source?.tavernResultOrigin === true) {
          found.push(event)
          partialTurns.add(Number(event.data.message.source.tavernResultTurn))
        }
        for (const source of Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []) visit(source)
      }
      visit(seq)
      return found.filter(event => storyRoundsIsReplace(event) || !partialTurns.has(Number(event.data.turn))).sort((a, b) => a.seq - b.seq)
    }
    const found = reachable(current.seq)
    if (!found.length) return [{ seq: current.seq, turn: Number(current.data.turn), text: textOf(current), current: true, ...incompleteOf(current) }]
    // 单一来源的正文编辑沿用被编辑结果的选择；重生成合并多个来源时，默认选最新生成。
    const visited = new Set()
    function selectedResult(event) {
      if (!event || visited.has(event.seq) || event.type !== 'assistant/message') return undefined
      visited.add(event.seq)
      if (event.data.message.source?.tavernResultOrigin === true && found.some(item => item.seq === event.seq)) return event.seq
      const named = Number(event.data.message.source?.tavernResultSeq)
      if (found.some(item => item.seq === named)) return named
      if (!storyRoundsIsReplace(event)) return found.some(item => item.seq === event.seq) ? event.seq : undefined
      const sources = event.sourceEventSeqs
      return Array.isArray(sources) && sources.length === 1 ? selectedResult(events.get(sources[0])) : undefined
    }
    const currentSeq = selectedResult(current) ?? found[found.length - 1].seq
    return found.map(event => ({ seq: event.seq, turn: Number(event.data.turn), text: textOf(event), current: event.seq === currentSeq, ...incompleteOf(event) }))
  }
  function incompleteOf(event) {
    const source = event.data?.message?.source
    return source?.tavernIncomplete === true ? { incomplete: true, incompleteReason: String(source.tavernIncompleteReason || '已保留生成到的部分正文') } : {}
  }
  function failedEnd(turn) {
    const kind = ended.get(turn)
    return kind !== undefined && !STORY_SETTLED_ENDS.includes(kind) ? kind : ''
  }
  function abandonReason(seq, visible) {
    const failed = failedEnd(turnOf.get(seq))
    if (failed) return superseded.has(turnOf.get(seq)) ? 'superseded' : failed
    for (let next = replacedBy.get(seq), steps = 0; next !== undefined && steps < 1000; next = replacedBy.get(next), steps++) {
      const event = events.get(next)
      const content = event && (event.type === 'user/message' ? event.data && event.data.content : event.data && event.data.message && event.data.message.content)
      // An empty replacement is a tombstone (rollback, cleanup); a non-empty one an edit or repair.
      if (Array.isArray(content) && content.length === 0) return 'rolled-back'
      if (visible.has(next)) return ''
    }
    return visible.has(seq) ? '' : 'replaced'
  }

  // 迭代展开，避免多次压缩形成递归深栈；旧结果只沿当前有效 Surface 可达。
  function storyNodes() {
    const pending = nodes.slice().reverse(), visible = []
    while (pending.length) {
      const seq = pending.pop()
      const children = compacted.get(seq)
      if (children) { for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]) }
      else visible.push(seq)
    }
    return visible
  }

  // 只计算当前摘要实际覆盖的正文，不把已被普通撤回替换的摘要算进去。
  function compactedStories() {
    const pending = nodes.filter(seq => compacted.has(seq)), stories = new Set()
    while (pending.length) {
      const seq = pending.pop(), children = compacted.get(seq)
      if (children) { for (const child of children) pending.push(child) }
      else {
        const event = events.get(seq)
        if (storyRoundsIsModelReply(event) && textOf(event)) stories.add(storyOf(event))
      }
    }
    return [...stories].filter(turn => Number.isSafeInteger(turn) && turn > 0).sort((a, b) => a - b)
  }

  function result() {
    if (cached) return cached
    const floors = [], abandoned = []
    let inputs = [], open = null
    const opened = () => (open = open || { turn: running, inputs: [], reply: null })
    const renderedNodes = storyNodes()
    for (const seq of renderedNodes) {
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
      const history = historyOf(event)
      const selected = history.find(item => item.current)
      const incomplete = selected?.incomplete ? { incomplete: true, incompleteReason: selected.incompleteReason } : incompleteOf(event)
      const reply = { seq, turn, id: String(event.data.message.id || ''), text, ...incomplete }
      const previous = floors[floors.length - 1]
      // A later step of the same round (after a tool call) is that round's reply.
      if (!inputs.length && previous && previous.story === story) { previous.reply = reply; previous.history = history; continue }
      floors.push({ story, inputs, reply, history })
      inputs = []
    }
    const visible = new Set(renderedNodes)
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

  return { addEvents, result, compactedStories, get folded() { return last } }
}

/** The rounds of a whole log (or a page of it) at once. */
function foldStoryRounds(events) {
  const fold = createStoryRoundsFold()
  fold.addEvents(events)
  return fold.result()
}

// 旧版本可能只写了整轮作废标记；读取时不让摘要展开复活这些楼层。
function filterStoryRounds(rounds, suppressedTurns = []) {
  const suppressed = new Set(suppressedTurns.map(Number))
  return suppressed.size ? { ...rounds, floors: rounds.floors.filter(floor => !suppressed.has(floor.story)) } : rounds
}

export { createStoryRoundsFold, foldStoryRounds, filterStoryRounds, isCompactionCheckpoint, STRAY_CHECKPOINT_FORM }
