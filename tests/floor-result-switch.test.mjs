import { staleVariablesOf } from '../tavern-plugin/lib/story/state.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from './fixtures/dsh-session-host.mjs'
import { appendSessionEvent, sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import { planRegenerationSurface, regenerationProjection, applyRegenerationProjection } from '../tavern-plugin/lib/domain/rollback-surface.js'
import { replaceSessionSurface } from '../tavern-plugin/lib/domain/session-surface-mutations.js'
import { createStoryTimeline } from '../tavern-plugin/lib/domain/story-timeline.js'
import { projectReplyLayers } from '../tavern-plugin/lib/domain/reply-presentation.js'
import { createFloorResultSwitch } from '../tavern-plugin/lib/story/floor-result-switch.js'
import { foldStoryRounds } from '../tavern-plugin/lib/story/story-rounds.js'
import { projectChatSessionState, createSessionStateView } from '../tavern-plugin/lib/domain/chat-session-state.js'

const MODEL = { kind: 'model', provider: 'test', model: 'test' }
const reply = (id, turn, text, source = MODEL) => ({ turn, step: 1, message: { id, role: 'assistant', content: [{ type: 'text', text }], source } })
function playTurn(session, turn, input, body) {
  appendSessionEvent(session, 'turn/start', { turn })
  if (input !== null) appendSessionEvent(session, 'user/message', { id: 'in-' + turn, role: 'user', content: [{ type: 'text', text: input }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'step/start', { turn, step: 1 })
  const seq = appendSessionEvent(session, 'assistant/message', reply('reply-' + turn, turn, body), { surfaceOp: 'append' }).seq
  appendSessionEvent(session, 'step/end', { turn, step: 1 })
  appendSessionEvent(session, 'turn/end', { turn, reason: { kind: 'completed' } })
  return seq
}
function regenerate(session, story, attemptTurn, text) {
  const events = sessionEvents(session)
  const old = session.surface.nodes.map(seq => events[seq]).findLast(event => event.type === 'assistant/message' && (event.data.message.source.tavernStoryTurn ?? event.data.turn) === story)
  const eventStart = events.length
  appendSessionEvent(session, 'turn/start', { turn: attemptTurn })
  appendSessionEvent(session, 'user/message', { id: 'regen-' + attemptTurn, role: 'user', content: [{ type: 'text', text: '重生成' }], source: { kind: 'plugin:dsh-tavern-regen' } }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'step/start', { turn: attemptTurn, step: 1 })
  const seq = appendSessionEvent(session, 'assistant/message', reply('attempt-' + attemptTurn, attemptTurn, text), { surfaceOp: 'append' }).seq
  appendSessionEvent(session, 'step/end', { turn: attemptTurn, step: 1 })
  appendSessionEvent(session, 'turn/end', { turn: attemptTurn, reason: { kind: 'completed' } })
  const plan = planRegenerationSurface({ events: sessionEvents(session), nodes: session.surface.nodes, oldAssistantSeq: old.seq, eventStart })
  applyRegenerationProjection(session, regenerationProjection(plan, reply('tavern-regen:' + attemptTurn, story, text, { ...MODEL, tavernStoryTurn: story }), 'op-' + attemptTurn))
  return seq
}
const floorRow = (turn, text) => ({ role: 'assistant', turn, text, sourceText: text, projectionText: text, displayText: text, swipeId: 0, swipes: [text] })

// A game whose latest round was regenerated twice; the save holds the newest body.
function fixture(name, { agentPhase = 'idle', settleStatus = 'done', mvu } = {}) {
  const session = Session.create(name)
  playTurn(session, 1, null, '开场白')
  playTurn(session, 2, '你好', '第二轮正文')
  const original = playTurn(session, 3, '继续', '第三轮正文')
  const first = regenerate(session, 3, 4, '重写一')
  const second = regenerate(session, 3, 6, '重写二')
  let chat = createStoryTimeline().apply({ chat: { id: 'chat-' + name, sessionId: session.id, mode: 'story', settleStatus, ...(mvu ? { mvu } : {}),
    messages: [{ ...floorRow(1, '开场白'), greeting: true }, { role: 'user', text: '你好' }, floorRow(2, '第二轮正文'), { role: 'user', text: '继续' }, floorRow(3, '重写二')] }, intent: { kind: 'ensure' } }).chat
  let flushes = 0
  const agent = { session, phase: { kind: agentPhase } }
  const switcher = createFloorResultSwitch({
    chats: { forSession: async () => structuredClone(chat), update: async (_id, mutate) => (chat = mutate(structuredClone(chat))) },
    sessions: { get: () => agent, flush: async () => { flushes++ } },
    timeline: createStoryTimeline(), activity: () => ({ busy: false }), project: async text => projectReplyLayers(text),
    present: async saved => ({ latest: saved.messages.at(-1).text }), id: (() => { let n = 0; return () => 'id-' + ++n })()
  })
  return { session, switcher, seqs: { original, first, second }, chat: () => chat, flushes: () => flushes }
}
const latest = session => foldStoryRounds(sessionEvents(session)).floors.at(-1)

test('切换到历史结果：存档正文、模型上下文与故事楼层都换成选中的那份，日志完整；再切回原结果', async () => {
  const f = fixture('switch-basic')
  assert.deepEqual(latest(f.session).history.map(item => [item.seq, item.current]), [[f.seqs.original, false], [f.seqs.first, false], [f.seqs.second, true]])
  const result = await f.switcher.switchResult({ sessionId: f.session.id, turn: 3, replySeq: f.seqs.original })
  assert.deepEqual(result, { switched: true, turn: 3, replySeq: f.seqs.original, mvu: 'stale', view: { latest: '第三轮正文' } })
  assert.equal(f.chat().messages.at(-1).sourceText, '第三轮正文')
  assert.deepEqual(f.chat().messages.at(-1).swipes, ['第三轮正文'])
  assert.equal(f.flushes(), 1)
  let floor = latest(f.session)
  assert.equal(floor.reply.text, '第三轮正文')
  assert.deepEqual(floor.history.map(item => [item.text, item.current]), [['第三轮正文', true], ['重写一', false], ['重写二', false]])
  const model = JSON.stringify(f.session.deriveMessages())
  assert.match(model, /第三轮正文/)
  assert.doesNotMatch(model, /重写二|重写一/)
  // The log keeps every generation; a cold read derives the same.
  for (const text of ['第三轮正文', '重写一', '重写二']) assert.ok(sessionEvents(f.session).some(event => event.data?.message?.content?.[0]?.text === text && event.surfaceOp === 'append'))
  const persisted = JSON.parse(JSON.stringify(sessionEvents(f.session)))
  assert.equal(JSON.stringify(Session.create(f.session.id, persisted, f.session.header).deriveMessages()), model)
  // Switching to the current result writes nothing.
  const events = sessionEvents(f.session).length
  assert.equal((await f.switcher.switchResult({ sessionId: f.session.id, turn: 3, replySeq: f.seqs.original })).switched, false)
  assert.equal(sessionEvents(f.session).length, events)
  // And back to where it was.
  assert.equal((await f.switcher.switchResult({ sessionId: f.session.id, turn: 3, replySeq: f.seqs.second })).switched, true)
  floor = latest(f.session)
  assert.equal(floor.reply.text, '重写二')
  assert.deepEqual(floor.history.map(item => item.current), [false, false, true])
  assert.equal(f.chat().messages.at(-1).sourceText, '重写二')
  assert.doesNotMatch(JSON.stringify(f.session.deriveMessages()), /第三轮正文/)
  assert.equal(foldStoryRounds(sessionEvents(f.session)).floors.length, 3)
})

test('官方 MVU 卡切换后存档标记变量未重算，编辑正文仍保留；非 MVU 卡不标', async () => {
  const f = fixture('switch-mvu-stale', { mvu: { enabled: true, owner: 'official' } })
  assert.equal(staleVariablesOf(f.chat()), null)
  await f.switcher.switchResult({ sessionId: f.session.id, turn: 3, replySeq: f.seqs.first })
  assert.deepEqual(f.chat().messages.at(-1).variablesStale, { replySeq: f.seqs.first })
  assert.deepEqual(staleVariablesOf(f.chat()), { turn: 3, replySeq: f.seqs.first })
  // 缓存命中的视图字段读的是投影后的存档，也带着标记。
  const projected = projectChatSessionState(f.chat())
  const volatile = createSessionStateView({ activity: () => ({ busy: false, phase: 'idle' }), evidence: () => ({}) }).volatile(projected, { busy: false, phase: 'idle' })
  assert.deepEqual(volatile.staleVariables, { turn: 3, replySeq: f.seqs.first })
  // 切到当前结果不写；再切到另一份仍标记为那一份。
  await f.switcher.switchResult({ sessionId: f.session.id, turn: 3, replySeq: f.seqs.first })
  assert.deepEqual(staleVariablesOf(f.chat()), { turn: 3, replySeq: f.seqs.first })
  await f.switcher.switchResult({ sessionId: f.session.id, turn: 3, replySeq: f.seqs.second })
  assert.deepEqual(staleVariablesOf(f.chat()), { turn: 3, replySeq: f.seqs.second })
  // 编辑只修改正文，不会重算变量，不能消除已经存在的未重算标记。
  const edited = createStoryTimeline().apply({ chat: f.chat(), intent: { kind: 'body.edit', turn: 3, patch: { text: '改过的正文' } } }).chat
  assert.deepEqual(staleVariablesOf(edited), { turn: 3, replySeq: f.seqs.second })

  for (const mvu of [undefined, { enabled: true, owner: 'legacy' }, { enabled: false }]) {
    const plain = fixture('switch-plain-' + JSON.stringify(mvu), { mvu })
    assert.equal((await plain.switcher.switchResult({ sessionId: plain.session.id, turn: 3, replySeq: plain.seqs.first })).mvu, 'stale')
    assert.equal(staleVariablesOf(plain.chat()), null)
  }
})

test('只允许最新一层、前台空闲、历史里有的结果', async () => {
  const f = fixture('switch-guards')
  await assert.rejects(f.switcher.switchResult({ sessionId: f.session.id, turn: 2, replySeq: f.seqs.original }), /最新一层/)
  await assert.rejects(f.switcher.switchResult({ sessionId: f.session.id, turn: 3, replySeq: 1 }), /没有这个历史结果/)
  await assert.rejects(f.switcher.switchResult({ sessionId: f.session.id, turn: 3, replySeq: 'x' }), /参数无效/)
  const running = fixture('switch-running', { agentPhase: 'running' })
  await assert.rejects(running.switcher.switchResult({ sessionId: running.session.id, turn: 3, replySeq: running.seqs.original }), /请等待/)
  const settling = fixture('switch-settling', { settleStatus: 'running' })
  await assert.rejects(settling.switcher.switchResult({ sessionId: settling.session.id, turn: 3, replySeq: settling.seqs.original }), /请等待/)
  assert.equal(f.chat().messages.at(-1).sourceText, '重写二')
})

test('结算投影副本（reply-projection）不算另一份历史结果，当前结果指向它投影的那份生成', () => {
  const session = Session.create('switch-projection')
  playTurn(session, 1, '一', '原始输出')
  const raw = sessionEvents(session).find(event => event.data?.message?.id === 'reply-1')
  appendSessionEvent(session, 'turn/start', { turn: 2 })
  replaceSessionSurface(session, 'assistant/message', reply('projection', 1, '正则处理后', { kind: 'model', provider: 'dsh-tavern', model: 'reply-projection' }), { start: raw.seq, end: raw.seq, sourceEventSeqs: [raw.seq] })
  appendSessionEvent(session, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  const floor = foldStoryRounds(sessionEvents(session)).floors.at(-1)
  assert.equal(floor.reply.text, '正则处理后')
  assert.deepEqual(floor.history.map(item => [item.seq, item.text, item.current]), [[raw.seq, '原始输出', true]])
})

test('RPC 结果切换后通知时间线，重复选中不重复通知', async () => {
  const { createStoryHandlers } = await import('../tavern-plugin/lib/rpc/story.js')
  const f = fixture('switch-rpc')
  const notifications = []
  const handlers = createStoryHandlers({ resultSwitch: f.switcher, notifyTimeline: (...args) => notifications.push(args) })
  const input = { sessionId: f.session.id, turn: 3, replySeq: f.seqs.first }
  assert.equal((await handlers.switchFloorResult(input)).switched, true)
  assert.equal(latest(f.session).reply.text, '重写一')
  assert.deepEqual(notifications, [[f.session.id, 'edit', { settled: true }]])
  assert.equal((await handlers.switchFloorResult(input)).switched, false)
  assert.equal(notifications.length, 1)
})

test('切换后的会话满足已发布 V4 关系约束', { skip: !process.env.DSH_BOOT_MODULE, timeout: 30000 }, async () => {
  const { pathToFileURL } = await import('node:url')
  const f = fixture('switch-v4')
  await f.switcher.switchResult({ sessionId: f.session.id, turn: 3, replySeq: f.seqs.first })
  const { assertReleasedV4Relationships } = await import(new URL('../../dsh-session-format-v3-to-v4/lib/index.js', pathToFileURL(process.env.DSH_BOOT_MODULE)))
  const events = sessionEvents(f.session)
  assertReleasedV4Relationships({ header: f.session.header, events, inheritedEventCount: 0 }, new Set(events.map(event => event.type)))
})
