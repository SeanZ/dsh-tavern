import test from 'node:test'
import assert from 'node:assert/strict'
import { planFailedTurnSurface, rollbackAvailability, clearRegenerationAttemptSurface } from '../tavern-plugin/lib/domain/rollback-surface.js'
import { Session } from './fixtures/dsh-session-host.mjs'
import { appendSessionEvent, sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import { replaceSessionSurface } from '../tavern-plugin/lib/domain/session-surface-mutations.js'

const user = (id, plugin) => ({ id, role: 'user', content: [{ type: 'text', text: id }], source: plugin ? { kind: 'plugin', plugin } : { kind: 'user' } })
const body = (id, turn) => ({ turn, step: 1, message: { id, role: 'assistant', content: [{ type: 'text', text: id }], source: { kind: 'model', provider: 'test', model: 'test' } } })
// The terminal submit_story shape: a model call that carries the body, the durable
// call record, and the receipt whose text is the body the tool returned.
const storyCall = (id, turn, callId, content) => ({ turn, step: 1, message: { id, role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'submit_story', arguments: JSON.stringify({ content }) }], source: { kind: 'model', provider: 'test', model: 'test' } } })
const storyReceipt = (id, turn, callId, text) => ({ turn, step: 1, message: { id, role: 'user', content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [{ type: 'text', text }] }], source: { kind: 'tool', callId } } })
const storyBody = (session, turn, callId, content) => {
  const call = appendSessionEvent(session, 'assistant/message', storyCall('call-' + callId, turn, callId, content), { surfaceOp: 'append' })
  appendSessionEvent(session, 'tool/call', { turn, step: 1, callId, name: 'submit_story', arguments: JSON.stringify({ content }) })
  const receipt = appendSessionEvent(session, 'tool/result', storyReceipt('receipt-' + callId, turn, callId, content), { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  return { call, receipt }
}
const storyTurn = (session, turn, callId, content) => {
  appendSessionEvent(session, 'turn/start', { turn })
  const result = storyBody(session, turn, callId, content)
  appendSessionEvent(session, 'turn/end', { turn, reason: { kind: 'completed' } })
  return result
}
function fixture() {
  const session = Session.create('surface-recovery')
  const context = appendSessionEvent(session, 'user/message', user('historical-context', 'context-provider'), { surfaceOp: 'append' })
  appendSessionEvent(session, 'assistant/message', body('old-body', 1), { surfaceOp: 'append' })
  const start = appendSessionEvent(session, 'turn/start', { turn: 2 })
  const refreshed = replaceSessionSurface(session, 'user/message', user('refreshed-context', 'context-provider'), { start: context.seq, end: context.seq, sourceEventSeqs: [context.seq] })
  const input = appendSessionEvent(session, 'user/message', user('attempt', 'dsh-tavern-regen'), { surfaceOp: 'append' })
  const reply = appendSessionEvent(session, 'assistant/message', body('partial', 2), { surfaceOp: 'append' })
  appendSessionEvent(session, 'turn/end', { turn: 2, reason: { kind: 'error' } })
  return { session, eventStart: start.seq, refreshed, input, reply }
}

test('归属跨回合混合或来源残缺时，清理拒绝写入', () => {
  for (const corrupt of ['mixed', 'missing', 'missing-all', 'forward']) {
    const f = fixture()
    const events = sessionEvents(f.session).map(event => structuredClone(event))
    const replacement = { seq: events.at(-1).seq + 1, type: 'assistant/message', data: body('replacement', 2),
      surfaceOp: { op: 'replace', start: f.reply.seq, end: f.reply.seq },
      sourceEventSeqs: corrupt === 'missing-all' ? [] : corrupt === 'mixed' ? [f.reply.seq, 1] : corrupt === 'missing' ? [f.reply.seq, 999] : [f.reply.seq, events.at(-1).seq + 1] }
    events.push(replacement)
    const nodes = f.session.surface.nodes.map(seq => seq === f.reply.seq ? replacement.seq : seq)
    const session = { events, surface: { nodes }, append() { assert.fail('unsafe recovery must not write') } }
    assert.throws(() => clearRegenerationAttemptSurface({ session, eventStart: f.eventStart }), /无法安全清理/)
    assert.throws(() => planFailedTurnSurface({ events, nodes, turn: 2 }), /无法安全清理/)
    const state = rollbackAvailability({ messages: [{ role: 'assistant', turn: 1 }] }, { events, nodes })
    assert.equal(state.canRollback, false)
  }
})

test('旧正文与重新生成之间夹着别处写入的消息（如卡片脚本消息）时，保留它并完成替换', async () => {
  const { planRegenerationSurface, regenerationProjection, applyRegenerationProjection } = await import('../tavern-plugin/lib/domain/rollback-surface.js')
  const session = Session.create('regen-foreign')
  appendSessionEvent(session, 'turn/start', { turn: 1 })
  const input = appendSessionEvent(session, 'user/message', user('input-1'), { surfaceOp: 'append' })
  const old = appendSessionEvent(session, 'assistant/message', body('old', 1), { surfaceOp: 'append' })
  appendSessionEvent(session, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  const script = appendSessionEvent(session, 'user/message', user('script-message', 'dsh-tavern-helper'), { surfaceOp: 'append' })
  const eventStart = sessionEvents(session).length
  appendSessionEvent(session, 'turn/start', { turn: 2 })
  appendSessionEvent(session, 'user/message', user('regen', 'dsh-tavern-regen'), { surfaceOp: 'append' })
  const fresh = appendSessionEvent(session, 'assistant/message', body('new', 2), { surfaceOp: 'append' })
  appendSessionEvent(session, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  const plan = planRegenerationSurface({ events: sessionEvents(session), nodes: session.surface.nodes, oldAssistantSeq: old.seq, eventStart })
  assert.deepEqual([plan.start, plan.end], [old.seq, old.seq])
  assert.equal(plan.cleanups.length, 1)
  assert.equal(plan.cleanups[0].end, fresh.seq)
  const projection = regenerationProjection(plan, { turn: 1, step: 1, message: { id: 'tavern-regen:op', role: 'assistant', content: [{ type: 'text', text: 'new' }], source: { kind: 'model', provider: 'test', model: 'test' } } }, 'op')
  applyRegenerationProjection(session, projection)
  applyRegenerationProjection(session, projection) // a retry after a crash writes nothing twice
  const visible = session.surface.nodes.map(seq => sessionEvents(session).find(event => event.seq === seq))
  assert.deepEqual(visible.map(event => event.data.message?.id ?? event.data.id), ['input-1', 'tavern-regen:op', 'script-message', 'tavern-regen-cleanup:op:0'])
  assert.equal(visible[2].seq, script.seq)
  assert.equal(input.seq, session.surface.nodes[0])
  // Another round's story reply in between is still never stepped over.
  const other = Session.create('regen-story-between')
  appendSessionEvent(other, 'user/message', user('input-1'), { surfaceOp: 'append' })
  const first = appendSessionEvent(other, 'assistant/message', body('old', 1), { surfaceOp: 'append' })
  appendSessionEvent(other, 'assistant/message', body('other-round', 5), { surfaceOp: 'append' })
  const start = sessionEvents(other).length
  appendSessionEvent(other, 'turn/start', { turn: 6 })
  appendSessionEvent(other, 'user/message', user('regen', 'dsh-tavern-regen'), { surfaceOp: 'append' })
  appendSessionEvent(other, 'assistant/message', body('new', 6), { surfaceOp: 'append' })
  appendSessionEvent(other, 'turn/end', { turn: 6, reason: { kind: 'completed' } })
  assert.throws(() => planRegenerationSurface({ events: sessionEvents(other), nodes: other.surface.nodes, oldAssistantSeq: first.seq, eventStart: start }), /归属不一致/)
})

// 重新生成一个「正文走工具调用」的回合（经生产规划 planRegenerationSurface）：
// - 生成期折叠缺席时，规划直接拒绝，不会留下两边都看不见的正文。
// - 旧正文与重新生成之间夹着别处写入的消息时，主范围只剩旧正文的折叠节点，尝试残留走清理。
//   这一轮不补 append 副本：原座位由存档投影（fromSave）显示新正文。模型面只有一份新正文，
//   异物消息与清理节点保留；全量、缓存、增量和冷读都只显示一份新正文，重试不重复写入。
test('工具回合的重新生成经生产规划：模型面和页面都只有一份新正文，重试不重复', async () => {
  const { foldStorySubmission } = await import('../tavern-plugin/lib/domain/story-tool-submission.js')
  const { planRegenerationSurface, regenerationProjection, applyRegenerationProjection } = await import('../tavern-plugin/lib/domain/rollback-surface.js')
  const { hostAssistantRows } = await import('./fixtures/host-assistant-rows.mjs')
  const { projectionFixture } = await import('./fixtures/session-view-projection.mjs')
  const { planShowsRow, planStoryTurn } = await import('../tavern-plugin/lib/domain/transcript-row-plan.js')
  const textOf = data => (data.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('')
  const data = { turn: 1, step: 1, message: { id: 'tavern-regen:op', role: 'assistant', content: [{ type: 'text', text: '新正文' }],
    source: { kind: 'model', provider: 'test', model: 'test', tavernStoryTurn: 1 } } }
  // 冷读要过宿主的种子校验：回执用 DSH 0.2 的 role: 'tool' 形状。
  const storyBody = (session, turn, callId, content) => {
    const call = appendSessionEvent(session, 'assistant/message', storyCall('call-' + callId, turn, callId, content), { surfaceOp: 'append' })
    appendSessionEvent(session, 'tool/call', { turn, step: 1, callId, name: 'submit_story', arguments: JSON.stringify({ content }) })
    const receipt = appendSessionEvent(session, 'tool/result', { turn, step: 1, message: { id: 'receipt-' + callId, role: 'tool', toolCallId: callId, toolName: 'submit_story',
      isError: false, content: [{ type: 'text', text: content }], source: { kind: 'tool', callId } } }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    return { call, receipt }
  }
  function regenerate(label, { fold, foreign }) {
    const session = Session.create(label)
    appendSessionEvent(session, 'turn/start', { turn: 1 })
    appendSessionEvent(session, 'user/message', user('input-1'), { surfaceOp: 'append' })
    const first = storyBody(session, 1, 'old', '旧正文')
    foldStorySubmission(session, { event: first.call, index: 0, receiptIndex: first.receipt.seq }, '旧正文')
    appendSessionEvent(session, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    const foldedSeq = session.surface.nodes.map(Number).at(-1)
    const script = foreign ? appendSessionEvent(session, 'user/message', user('script-message', 'dsh-tavern-helper'), { surfaceOp: 'append' }) : null
    const start = appendSessionEvent(session, 'turn/start', { turn: 2 })
    appendSessionEvent(session, 'user/message', user('regen', 'dsh-tavern-regen'), { surfaceOp: 'append' })
    const attempt = storyBody(session, 2, 'new', '新正文')
    if (fold) foldStorySubmission(session, { event: attempt.call, index: 0, receiptIndex: attempt.receipt.seq }, '新正文')
    appendSessionEvent(session, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
    const plan = () => planRegenerationSurface({ events: sessionEvents(session), nodes: session.surface.nodes, oldAssistantSeq: foldedSeq, eventStart: start.seq })
    return { session, foldedSeq, script, plan }
  }

  assert.throws(() => regenerate('regen-story-fold-missing', { fold: false }).plan(), /已有新的消息/)

  const { session, foldedSeq, script, plan: planOf } = regenerate('regen-story-foreign', { fold: true, foreign: true })
  const plan = planOf()
  assert.deepEqual([plan.start, plan.end], [foldedSeq, foldedSeq], '主范围只有旧正文的折叠节点')
  assert.ok(plan.cleanups.length > 0, '尝试残留由清理覆盖')
  const projection = regenerationProjection(plan, data, 'op')
  const appends = () => sessionEvents(session).filter(event => event.type === 'assistant/message' && event.surfaceOp === 'append').length
  applyRegenerationProjection(session, projection)
  const appended = appends()
  applyRegenerationProjection(session, projection)
  assert.equal(appends(), appended, '重试不再写正文')
  const modelSurface = () => session.surface.nodes.map(seq => sessionEvents(session).find(event => event.seq === seq))
  const bodies = modelSurface().filter(event => event.type === 'assistant/message' && textOf(event.data))
  assert.deepEqual(bodies.map(event => textOf(event.data)), ['新正文'], '模型上下文只有一份新正文')
  assert.ok(session.surface.nodes.includes(script.seq), '异物消息保留')
  assert.ok(modelSurface().some(event => String(event.data?.id ?? '').startsWith('tavern-regen-cleanup:op')), '清理节点保留')

  let current = session
  const fixture = projectionFixture({ sessionDebugEvidence: () => ({ session: current, loaded: true, events: sessionEvents(current), nodes: current.surface.nodes }) })
  const chat = Object.assign(fixture.chat, { sessionId: session.id,
    messages: [{ role: 'user', text: 'input-1' }, { role: 'assistant', turn: 1, text: '新正文' }] })
  const before = await fixture.projection.project.full(chat)
  const views = [
    before,
    await fixture.projection.project.cached(chat, before, { busy: false, phase: 'idle' }),
    await fixture.projection.project.dirty(chat, before, [1], { busy: false, phase: 'idle' }),
  ]
  current = Session.fromRestore(session.id, JSON.parse(JSON.stringify(sessionEvents(session))))
  views.push(await fixture.projection.project.full(chat))
  for (const view of views) {
    const shown = hostAssistantRows(sessionEvents(current)).filter(row => planShowsRow(view.transcriptTurns, row))
      .map(row => view.replyProjections?.find(item => item.turn === planStoryTurn(view.transcriptTurns, row.turn))?.text || row.text)
    assert.deepEqual(shown, ['新正文'], '页面只显示一份新正文')
  }
})

// 折叠在场时，副本落在被替换的旧回合里；那个回合随后会作为 superseded 被隐藏。
// 投影若把这份副本当成「已经画过」而复用，页面上唯一能画的行正好被藏掉。
test('折叠副本落在被替换的回合里时，投影仍要补一份新的可画正文', async () => {
  const { foldStorySubmission } = await import('../tavern-plugin/lib/domain/story-tool-submission.js')
  const { applyRegenerationProjection, supersededRegenerationTurns } = await import('../tavern-plugin/lib/domain/rollback-surface.js')
  const session = Session.create('regen-fold-inside-range')
  appendSessionEvent(session, 'turn/start', { turn: 1 })
  appendSessionEvent(session, 'user/message', user('input-1'), { surfaceOp: 'append' })
  const old = storyBody(session, 1, 'old', '旧正文')
  foldStorySubmission(session, { event: old.call, index: 0, receiptIndex: old.receipt.seq }, '旧正文')
  appendSessionEvent(session, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  const oldFolded = session.surface.nodes.map(Number).at(-1)

  appendSessionEvent(session, 'turn/start', { turn: 2 })
  appendSessionEvent(session, 'user/message', user('regen', 'dsh-tavern-regen'), { surfaceOp: 'append' })
  const attempt = storyBody(session, 2, 'new', '新正文')
  foldStorySubmission(session, { event: attempt.call, index: 0, receiptIndex: attempt.receipt.seq }, '新正文')
  appendSessionEvent(session, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  const textOf = data => (data.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('')
  const foldCopy = sessionEvents(session).find(event => event.type === 'assistant/message' &&
    event.surfaceOp === 'append' && textOf(event.data) === '新正文')
  const foldReplace = session.surface.nodes.map(Number).at(-1)
  assert.ok(foldCopy && foldCopy.seq < foldReplace, '折叠副本落在被替换的范围里')

  const projection = {
    data: {
      turn: 2, step: 1,
      message: {
        id: 'tavern-regen:op2', role: 'assistant', content: [{ type: 'text', text: '新正文' }],
        source: { kind: 'model', provider: 'test', model: 'test', tavernStoryTurn: 2 },
      },
    },
    range: { start: oldFolded, end: foldReplace, sourceEventSeqs: session.surface.nodes.slice(session.surface.nodes.indexOf(oldFolded)) },
    cleanups: [],
  }
  applyRegenerationProjection(session, projection)
  const afterRange = sessionEvents(session).filter(event => event.type === 'assistant/message' &&
    event.surfaceOp === 'append' && event.seq > foldReplace && textOf(event.data) === '新正文')
  assert.equal(afterRange.length, 1, '被隐藏回合里的副本不能当成交付')
  const superseded = supersededRegenerationTurns({ events: sessionEvents(session), nodes: session.surface.nodes })
  assert.ok(superseded.includes(2), '被替换的旧回合仍在隐藏名单里')
  assert.ok(!superseded.includes(Number(afterRange[0].data.turn)), '新副本所在回合不能被隐藏')
  applyRegenerationProjection(session, projection)
  assert.equal(sessionEvents(session).filter(event => event.type === 'assistant/message' &&
    event.surfaceOp === 'append' && event.seq > foldReplace && textOf(event.data) === '新正文').length, 1)
})

// #304：宿主在生成期回合里写的 developer 消息属于这一轮。认不出它时，生成期被切成两段，
// 主替换停在玩家输入上、不补可画副本，生成期自己的正文又被清成空标记，整楼空白。
test('生成期回合里的宿主 developer 消息不切开重新生成，替换收尾在新正文上', async () => {
  const { planRegenerationSurface } = await import('../tavern-plugin/lib/domain/rollback-surface.js')
  const session = Session.create('regen-developer-note')
  appendSessionEvent(session, 'turn/start', { turn: 1 })
  appendSessionEvent(session, 'user/message', user('input-1'), { surfaceOp: 'append' })
  const old = appendSessionEvent(session, 'assistant/message', body('old-body', 1), { surfaceOp: 'append' })
  appendSessionEvent(session, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  const start = appendSessionEvent(session, 'turn/start', { turn: 2 })
  appendSessionEvent(session, 'user/message', user('regen', 'dsh-tavern-regen'), { surfaceOp: 'append' })
  appendSessionEvent(session, 'developer/message', { turn: 2, step: 1, message: { id: 'host-note', role: 'developer', content: [{ type: 'text', text: '宿主提示' }] } }, { surfaceOp: 'append' })
  const reply = appendSessionEvent(session, 'assistant/message', body('new-body', 2), { surfaceOp: 'append' })
  appendSessionEvent(session, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  const plan = planRegenerationSurface({ events: sessionEvents(session), nodes: session.surface.nodes, oldAssistantSeq: old.seq, eventStart: start.seq })
  assert.equal(plan.cleanups.length, 0)
  assert.equal(plan.shadowedSeqs.at(-1), reply.seq)
})

// clearFailedTurns reads the save's header and latest floors only (long saves): the
// failed tail after the latest round must come out the same as with the whole history.
test('判断失败尾巴只需最后几层楼：结果与完整存档相同', () => {
  const session = Session.create('failed-tail-latest-floors')
  const messages = []
  for (const turn of [1, 2, 3]) {
    appendSessionEvent(session, 'turn/start', { turn })
    appendSessionEvent(session, 'user/message', user('input-' + turn), { surfaceOp: 'append' })
    appendSessionEvent(session, 'assistant/message', body('reply-' + turn, turn), { surfaceOp: 'append' })
    appendSessionEvent(session, 'turn/end', { turn, reason: { kind: 'completed' } })
    messages.push({ role: 'user', text: 'input-' + turn }, { role: 'assistant', turn, text: 'reply-' + turn })
  }
  appendSessionEvent(session, 'turn/start', { turn: 4 })
  appendSessionEvent(session, 'user/message', user('input-4'), { surfaceOp: 'append' })
  appendSessionEvent(session, 'assistant/message', body('partial', 4), { surfaceOp: 'append' })
  appendSessionEvent(session, 'turn/end', { turn: 4, reason: { kind: 'error' } })
  const input = { events: sessionEvents(session), nodes: session.surface.nodes }
  const whole = rollbackAvailability({ messages }, input)
  const latest = rollbackAvailability({ messages: messages.slice(-3) }, input)
  assert.deepEqual(whole.unclearedTurns, [4])
  assert.deepEqual(latest.unclearedTurns, whole.unclearedTurns)
  assert.equal(latest.canRollback, whole.canRollback)
})
