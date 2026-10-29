// Replay a session log against what the player's conversation page shows.
//
// The host draws every append-origin message forever; Tavern then hides rows by native
// turn (Wiki「设计：transcript-row-plan」). This replays both halves outside the app:
// the host's rows are modelled from the log, the server view comes from the real
// createSessionStateView, and the hiding runs the real client bundle in a browser page.
// The check is the invariant the page must keep: every story round in the save shows one
// input and one reply, and no reply shows for a round the save does not have.
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { createSessionStateView } from '../../tavern-plugin/lib/domain/chat-session-state.js'
import { sessionEvents } from '../../tavern-plugin/lib/domain/session-events.js'
import { createTranscriptFold, planShowsRow, planStoryTurn } from '../../tavern-plugin/lib/domain/transcript-row-plan.js'

const SEED_REPLY = /^tavern-seed-trajectory:v1:.+:2$/
const isRegenerationInput = source => source?.plugin === 'dsh-tavern-regen' || source?.kind === 'plugin:dsh-tavern-regen'

function textOf(message) {
  return (message?.content || []).filter(block => block?.type === 'text').map(block => block.text).join('')
}

/**
 * The rows the host's chat view builds from a log: one assistant-step per step (append
 * messages only; replacements stay model-only), the player's input, the trigger card of
 * a turn a plugin message woke, plugin context, and one tail per finished turn.
 */
export function hostRows(events) {
  const rows = []
  const steps = new Map()
  let turn = null, woke = false
  // A message queued before its turn starts (the inbox splices it in) opens that turn.
  let queued = []
  for (const event of events) {
    if (!event) continue
    if (event.type === 'turn/start') {
      turn = Number(event.data?.turn)
      woke = queued.some(row => row.kind === 'user')
      for (const row of queued) row.turn = turn
      queued = []
      continue
    }
    if (event.type === 'turn/end') {
      rows.push({ seq: event.seq, turn: Number(event.data?.turn), kind: 'turn-tail', text: '' })
      turn = null
      continue
    }
    if (event.surfaceOp !== 'append') continue
    if (event.type === 'user/message') {
      const source = event.data?.source
      // The host draws a plugin message as the trigger card only when the inbox handed it
      // over to wake a turn; Tavern does that for a regeneration input. The rest is context.
      const kind = source?.kind === 'user' ? 'user' : !woke && isRegenerationInput(source) ? 'turn-trigger' : 'context'
      if (kind !== 'context') woke = true
      const row = { seq: event.seq, turn, kind, text: textOf(event.data), source: source?.plugin || source?.kind || '' }
      rows.push(row)
      if (turn === null) queued.push(row)
      continue
    }
    if (event.type !== 'assistant/message') continue
    const owner = Number(event.data?.turn), step = Number(event.data?.step) || 1
    const key = owner + ':' + step
    let row = steps.get(key)
    if (!row) {
      row = { seq: event.seq, turn: owner, step, kind: 'assistant-step', text: '', tools: 0, ids: [] }
      steps.set(key, row)
      rows.push(row)
    }
    row.text += textOf(event.data?.message)
    row.tools += (event.data?.message?.content || []).filter(block => block?.type === 'tool-call').length
    row.ids.push(String(event.data?.message?.id || ''))
  }
  // A step with nothing visible is never drawn; Tavern hides its own seed reply.
  // The renderer judges a step by its final message.
  return rows.filter(row => row.kind !== 'assistant-step' || ((row.text.trim() !== '' || row.tools > 0) && !SEED_REPLY.test(row.ids.at(-1))))
}

/** The server's visibility fields for this save and log, from the production view. */
export function serverView(chat, session) {
  const events = sessionEvents(session)
  const fields = createSessionStateView({ activity: () => ({ busy: false }), evidence: () => ({ session, events }) })
  return fields.rollback({ id: chat.id || 'chat', sessionId: session.id, mode: 'story', ...chat }, { session, events })
}

let browserPromise = null
async function page() {
  browserPromise ??= chromium.launch({ headless: true })
  const browser = await browserPromise
  const tab = await browser.newPage()
  const source = await readFile(new URL('../../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
  await tab.setContent('<main></main>')
  await tab.evaluate(source => {
    window.__ModuleLoader__ = { load(definition) { window.client = definition.factory(() => ({})) } }
    window.eval(source)
  }, source)
  return tab
}
export async function closeReplay() {
  if (browserPromise) await (await browserPromise).close()
  browserPromise = null
}

/** Run the client's own hiding over the modelled rows; returns the rows with `visible`. */
export async function visibleRows(rows, view) {
  const tab = await page()
  try {
    const shown = await tab.evaluate(({ rows, view }) => {
      const root = document.querySelector('main')
      for (const row of rows) {
        const node = document.createElement('div')
        node.setAttribute('data-chat-flow-kind', row.kind)
        if (row.turn !== null) node.setAttribute('data-chat-turn', String(row.turn))
        root.append(node)
      }
      const projection = client.createTurnHistoryProjection({ root: () => root, storage: () => ({ getItem: () => '{}', setItem() {}, removeItem() {} }) })
      projection.apply('replay', view.transcriptTurns ? { turns: view.transcriptTurns, from: view.transcriptFrom ?? null } : null)
      return { visible: Array.from(root.children, node => getComputedStyle(node).display !== 'none') }
    }, { rows, view })
    return rows.map((row, index) => ({ ...row, visible: shown.visible[index] }))
  } finally { await tab.close() }
}

/** The story turn the assistant renderer draws a native turn's reply as (tavernStoryTurnForDshTurn). */
export function storyTurnOf(view, turn) {
  for (const [story, native] of Object.entries(view.regeneratedDshTurns || {})) if (Number(native) === Number(turn)) return Number(story)
  return Number(turn)
}

/**
 * What the player sees per story round, and every way it breaks the page's invariant.
 * Only a turn's closing step draws the round's story; earlier steps show their own text.
 */
export function transcriptReport(chat, rows, view, storyTurn = turn => storyTurnOf(view, turn), open = null) {
  const rounds = new Map()
  let inferred = 1
  for (const message of chat.messages || []) {
    if (message?.role === 'user') { inferred += 1; continue }
    if (message?.role !== 'assistant') continue
    const story = Number(message.turn) || (message.greeting === true ? 1 : inferred)
    if (!(story > 0)) continue
    rounds.set(story, { story, greeting: message.greeting === true, saved: String(message.text ?? ''), inputs: [], replies: [] })
  }
  const closing = new Map()
  for (const row of rows) if (row.kind === 'assistant-step') closing.set(row.turn, row)
  const orphans = []
  for (const row of rows) {
    if (!row.visible) continue
    // A turn the save does not hold yet (running, failed, settling) is meant to show.
    if (open !== null && Number(row.turn) === Number(open)) continue
    if (row.kind === 'user' || row.kind === 'turn-trigger') {
      const round = rounds.get(Number(row.turn))
      if (round) round.inputs.push(row)
      else orphans.push({ kind: 'input', row })
    }
    if (row.kind === 'assistant-step' && closing.get(row.turn) === row) {
      const story = storyTurn(row.turn)
      const round = rounds.get(story)
      if (round) round.replies.push(row)
      else orphans.push({ kind: 'reply', story, row })
    }
  }
  const problems = [], stale = []
  // A round still being written (regenerating, settling) is not judged yet.
  const live = view.replacingDshTurns?.length || chat.regenInProgress === true
  for (const round of rounds.values()) {
    if (live) break
    // The opening has display paths of its own (legacy greeting, prepared message).
    if (round.greeting) continue
    if (round.replies.length === 0) problems.push(`第 ${round.story} 轮没有可见正文`)
    if (round.replies.length > 1) problems.push(`第 ${round.story} 轮有 ${round.replies.length} 份正文：原生轮 ${round.replies.map(row => row.turn).join('、')}`)
    // The renderer draws the save's projection when it has one, else the row's own text;
    // a row still holding an older version is only safe in the first case.
    if (round.replies.length === 1 && round.replies[0].text.trim() !== round.saved.trim()) stale.push(`第 ${round.story} 轮显示的行（原生轮 ${round.replies[0].turn}）不是存档里这一版`)
    if (!round.greeting && round.inputs.filter(row => row.kind === 'user').length > 1) problems.push(`第 ${round.story} 轮的玩家输入出现了 ${round.inputs.length} 次`)
  }
  for (const orphan of orphans) {
    if (orphan.kind === 'reply') problems.push(`原生轮 ${orphan.row.turn} 的正文可见，但存档没有第 ${orphan.story} 轮`)
    else if (orphan.row.kind === 'user') problems.push(`原生轮 ${orphan.row.turn} 的玩家输入可见，但存档没有这一轮`)
    else problems.push(`原生轮 ${orphan.row.turn} 的触发卡（${orphan.row.source}）可见`)
  }
  return { rounds: [...rounds.values()], orphans, problems, stale }
}

/**
 * Everything at once: rows, server view, and what the page shows under the current
 * hiding lists and under the row plan, each checked against the invariant.
 */
export async function replayTranscript(chat, session) {
  const events = sessionEvents(session)
  const fold = createTranscriptFold()
  fold.setFloors(0, (chat.messages || []).map(message => ({ role: message?.role, turn: message?.turn, greeting: message?.greeting })))
  fold.addEvents(events, 0)
  const fields = serverView(chat, session)
  fold.setRegeneration({ replacing: fields.replacingDshTurns, inProgress: chat.regenInProgress === true })
  fold.setKeepInput(fields.keptInputTurns)
  const plan = fold.result()
  const view = { ...fields, transcriptTurns: plan }
  const rows = await visibleRows(hostRows(events), view)
  const planned = rows.map(row => ({ ...row, visible: planShowsRow(plan, row) }))
  return { view, rows, ...transcriptReport(chat, rows, view, turn => planStoryTurn(plan, turn), fold.open),
    plan: { plan, open: fold.open, rows: planned, ...transcriptReport(chat, planned, view, turn => planStoryTurn(plan, turn), fold.open) } }
}
