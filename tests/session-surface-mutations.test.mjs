import test from 'node:test'
import assert from 'node:assert/strict'
import { replaceSessionSurface } from "../tavern-plugin/lib/domain/session-surface-mutations.js"

function fixture() {
  const events = [{seq: 0, type: 'assistant/message', data: {message: {id: 'old'}}}]
  return {events, surface: {nodes: [0]}, append(type, data, intent) {
    const event = {seq: events.length, type, data, ...intent}; events.push(event)
    this.surface.nodes = [event.seq]; return event
  }}
}
const data = {turn: 1, step: 1, message: {id: 'edit-1', role: 'assistant', content: [{type: 'text', text: '新正文'}]}}
const target = {start: 0, end: 0, sourceEventSeqs: [0]}
test('重复提交复用原事件，冲突及失效目标不产生任何追加', () => {
  const session = fixture()
  const first = replaceSessionSurface(session, 'assistant/message', data, target)
  assert.equal(replaceSessionSurface(session, 'assistant/message', structuredClone(data), target), first)
  assert.equal(session.events.length, 2)
  assert.throws(() => replaceSessionSurface(session, 'assistant/message', {...data, turn: 2}, target), /不同内容/)
  assert.throws(() => replaceSessionSurface(session, 'assistant/message', {...data, message: {...data.message, id: 'other'}}, target), /目标已变化/)
  assert.equal(session.events.length, 2)
})

// Released V4 refuses a surface event outside an open step and the whole archive
// stops loading ("assistant/message does not match an open turn and step").
// A rewrite between rounds therefore opens a step of its own.
function turnFixture({ closeTurn = false } = {}) {
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 2, type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'old' } }, surfaceOp: 'append' },
    { seq: 3, type: 'step/end', data: { turn: 1, step: 1 } },
  ]
  if (closeTurn) events.push({ seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  return {
    header: { version: 4 },
    events,
    surface: { nodes: [2] },
    append(type, data, intent) {
      const event = { seq: events.length, type, data, ...intent }
      events.push(event)
      if (type === 'assistant/message' && intent?.surfaceOp) this.surface.nodes = [event.seq]
      return event
    },
  }
}

const turnTarget = { start: 2, end: 2, sourceEventSeqs: [2] }

test('回合之间替换正文：自动开一个 step，事件落在其中并可按重试复用', () => {
  const session = turnFixture()
  const written = replaceSessionSurface(session, 'assistant/message', data, turnTarget)
  const [stepStart, replacement, stepEnd] = session.events.slice(-3)
  assert.equal(stepStart.type, 'step/start')
  assert.deepEqual(stepStart.data, { turn: 1, step: 2 })
  assert.equal(replacement, written)
  assert.equal(replacement.data.turn, 1)
  assert.equal(replacement.data.step, 2)
  assert.equal(stepEnd.type, 'step/end')
  assert.deepEqual(stepEnd.data, { turn: 1, step: 2 })
  // Retry with the caller's original placement still reuses the same event.
  assert.equal(replaceSessionSurface(session, 'assistant/message', structuredClone(data), turnTarget), written)
  assert.equal(session.events.length, 7)
})

test('回合已关闭时替换正文：自开专用回合并推进 idle Agent 的回合号', async () => {
  const { setAgentResolver } = await import('../tavern-plugin/lib/domain/agent-lookup.js')
  const agent = { phase: { kind: 'idle', lastTurn: 1 } }
  setAgentResolver(() => agent)
  try {
    const session = turnFixture({ closeTurn: true })
    const written = replaceSessionSurface(session, 'assistant/message', data, turnTarget)
    const tail = session.events.slice(-5)
    assert.equal(tail[0].type, 'turn/start')
    assert.equal(tail[0].data.turn, 2)
    assert.equal(tail[1].type, 'step/start')
    assert.equal(tail[2], written)
    assert.equal(written.data.turn, 2)
    assert.equal(written.data.step, 1)
    assert.equal(tail[3].type, 'step/end')
    assert.equal(tail[4].type, 'turn/end')
    assert.equal(agent.phase.lastTurn, 2)
  } finally { setAgentResolver(null) }
})

// Body edits name their original round (turn N, step 1) long after it closed.
test('正文编辑写在已结束回合之后，存档仍满足 released V4 的回合约束', { skip: !process.env.DSH_BOOT_MODULE, timeout: 30000 }, async () => {
  const { pathToFileURL } = await import('node:url')
  const { sessionEvents } = await import('../tavern-plugin/lib/domain/session-events.js')
  const { assertReleasedV4Relationships } = await import(
    new URL('../../dsh-session-format-v3-to-v4/lib/index.js', pathToFileURL(process.env.DSH_BOOT_MODULE)))
  const header = { type: 'session', version: 4, id: 'body-edit-fixture', createdAt: 1, cwd: '/tmp', isSeeded: false, delegationDepth: 0, agentPreset: 'tavern' }
  for (const closeTurn of [true, false]) {
    const events = []
    const session = { header, id: header.id, events, surface: { nodes: [] }, append(type, eventData, options = {}) {
      const event = { seq: events.length, type, data: eventData, ...options }
      events.push(event)
      if (options.surfaceOp?.op === 'replace') {
        const start = this.surface.nodes.indexOf(options.surfaceOp.start)
        this.surface.nodes.splice(start, this.surface.nodes.indexOf(options.surfaceOp.end) - start + 1, event.seq)
      } else if (options.surfaceOp === 'append') this.surface.nodes.push(event.seq)
      return event
    } }
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('system/message', { turn: 1, step: 1, message: { id: 'head', role: 'system', content: [], source: { kind: 'system-prompt' } } }, { surfaceOp: 'append' })
    session.append('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: '问' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '答' }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } } }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    if (closeTurn) session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    replaceSessionSurface(session, 'assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '改过的答' }], source: { kind: 'model', provider: 'dsh-tavern', model: 'body-edit' } } }, { start: 4, end: 4, sourceEventSeqs: [4] })
    const written = sessionEvents(session)
    assertReleasedV4Relationships({ header, events: written, inheritedEventCount: 0 }, new Set(written.map(event => event.type)))
  }
})

// issue #247: settlement and native repair appended replies after their round closed.
test('回合结束后的追加、正文提交折叠与原生上下文修复都写进编辑步骤，存档满足 released V4 的回合约束', { skip: !process.env.DSH_BOOT_MODULE, timeout: 30000 }, async () => {
  const { pathToFileURL } = await import('node:url')
  const { sessionEvents } = await import('../tavern-plugin/lib/domain/session-events.js')
  const { createSessionSurfaceMutator } = await import('../tavern-plugin/lib/domain/session-surface-mutations.js')
  const { foldStorySubmission } = await import('../tavern-plugin/lib/domain/story-tool-submission.js')
  const { applyNativeSurfaceRepair } = await import('../tavern-plugin/lib/domain/native-surface-repair.js')
  const { storyEventTurn } = await import('../tavern-plugin/lib/domain/session-upgrade-references.js')
  const { assertReleasedV4Relationships } = await import(
    new URL('../../dsh-session-format-v3-to-v4/lib/index.js', pathToFileURL(process.env.DSH_BOOT_MODULE)))
  const header = { type: 'session', version: 4, id: 'late-write-fixture', createdAt: 1, cwd: '/tmp', isSeeded: false, delegationDepth: 0, agentPreset: 'tavern' }
  const model = { kind: 'model', provider: 'fixture', model: 'fixture' }
  function played({ closeTurn }) {
    const events = []
    const session = { header, id: header.id, events, surface: { nodes: [] }, append(type, eventData, options = {}) {
      const event = { seq: events.length, type, data: eventData, ...options }
      events.push(event)
      if (options.surfaceOp?.op === 'replace') {
        const start = this.surface.nodes.indexOf(options.surfaceOp.start)
        this.surface.nodes.splice(start, this.surface.nodes.indexOf(options.surfaceOp.end) - start + 1, event.seq)
      } else if (options.surfaceOp === 'append') this.surface.nodes.push(event.seq)
      return event
    } }
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: '问' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const call = session.append('assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'submit_story', arguments: '{}' }], source: model } }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'submit_story', arguments: '{}' })
    const receipt = session.append('tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', toolName: 'submit_story', content: [{ type: 'text', text: '已提交' }], source: { kind: 'tool' } } }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    if (closeTurn) session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    return { session, call, receipt }
  }
  const valid = session => {
    const written = sessionEvents(session)
    assertReleasedV4Relationships({ header, events: written, inheritedEventCount: 0 }, new Set(written.map(event => event.type)))
  }

  // Settlement folds a submission while the turn is still open but its step closed.
  {
    const { session, call, receipt } = played({ closeTurn: false })
    foldStorySubmission(session, { event: call, index: call.seq, receiptIndex: receipt.seq }, '正文')
    valid(session)
    const steps = sessionEvents(session).filter(event => event.type === 'step/start')
    assert.equal(steps.length, 2, 'the copy and its replacement share one edit step')
  }
  // A plain late append, between rounds.
  {
    const { session } = played({ closeTurn: true })
    createSessionSurfaceMutator(session).append('assistant/message', { turn: 1, step: 1, message: { id: 'late', role: 'assistant', content: [{ type: 'text', text: '迟到' }], source: model } }, { surfaceOp: 'append', sourceEventSeqs: [] })
    valid(session)
  }
  // Native repair writes two older rounds back after the last round ended.
  {
    const { session } = played({ closeTurn: true })
    const plan = { status: 'tail', keep: session.surface.nodes.length, checkpoint: -1, rounds: [
      { turn: 34, messageIndex: 1, userText: '行动34', replyText: '正文34' },
      { turn: 35, messageIndex: 3, userText: '行动35', replyText: '正文35' },
    ] }
    const result = applyNativeSurfaceRepair(session, { id: 'chat' }, plan, { repairId: 'r1' })
    valid(session)
    assert.equal(sessionEvents(session).filter(event => event.type === 'turn/start').length, 3, '每轮修复独立开闭可绘制步骤')
    const replies = sessionEvents(session).filter(event => event.data?.message?.source?.model === 'native-repair')
    assert.deepEqual(replies.map(storyEventTurn), [34, 35], 'each reply keeps its story turn')
    assert.deepEqual(result.anchors.map(item => item.anchor.turn), [34, 35])
  }
})

test('同一会话的脱离副本（预演）开编辑回合时，不推进真 Agent 的回合号', async () => {
  const { setAgentResolver } = await import('../tavern-plugin/lib/domain/agent-lookup.js')
  const live = turnFixture({ closeTurn: true })
  const preview = turnFixture({ closeTurn: true })
  preview.id = live.id
  const agent = { session: live, phase: { kind: 'idle', lastTurn: 1 } }
  setAgentResolver(() => agent)
  try {
    replaceSessionSurface(preview, 'assistant/message', structuredClone(data), turnTarget)
    assert.equal(preview.events.filter(event => event.type === 'turn/start').at(-1).data.turn, 2, '预演副本自己照常开编辑回合')
    assert.equal(agent.phase.lastTurn, 1, '真会话没有第 2 轮，下一轮仍应是第 2 轮，不能跳号')
    replaceSessionSurface(live, 'assistant/message', structuredClone(data), turnTarget)
    assert.equal(agent.phase.lastTurn, 2, '真会话自己的编辑回合照常登记')
  } finally { setAgentResolver(null) }
})
