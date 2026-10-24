import test from 'node:test'
import assert from 'node:assert/strict'
import { createReplySeatResolver } from '../tavern-plugin/lib/domain/reply-seat.js'
import { projectedReplyTurns, keptPlayerInputTurns } from '../tavern-plugin/lib/domain/rollback-surface.js'
import { createTranscriptFold, planTranscriptRows } from '../tavern-plugin/lib/domain/transcript-row-plan.js'

const reply = (seq, turn, op = 'append', sources) => ({
  seq,
  type: 'assistant/message',
  surfaceOp: op,
  ...(sources ? { sourceEventSeqs: sources } : {}),
  data: {
    turn,
    step: 1,
    message: { content: [{ type: 'text', text: '正文' }], source: { kind: 'model', tavernStoryTurn: 2 } },
  },
})
const replace = (seq, target, sources = [target]) =>
  reply(seq, seq + 10, { op: 'replace', start: target, end: target }, sources)
const resolve = (events) => createReplySeatResolver((seq) => events.find((event) => event.seq === seq))(events.at(-1))

test('多层正文替换的行计划和映射共用实际追加座位', () => {
  const events = [reply(0, 4), replace(1, 0), replace(2, 1), replace(3, 2)]
  assert.deepEqual(resolve(events), { seq: 0, turn: 4 })
  assert.equal(projectedReplyTurns({ events, nodes: [3] }).get(2), 4)
  const chat = { messages: [{ role: 'user' }, { role: 'assistant', turn: 2 }] }
  const full = planTranscriptRows({ chat, events })
  assert.equal(full['4'].story, 2)
  assert.equal(full['2'].reply, 0)
  const fold = createTranscriptFold()
  fold.setFloors(0, chat.messages)
  for (let count = 1; count <= events.length; count++) fold.addEvents(events.slice(0, count))
  assert.deepEqual({ ...fold.result() }, { ...full })
})

test('缺失、未来、越界和断裂来源都不能猜测正文座位', () => {
  for (const bad of [
    replace(2, 7),
    replace(2, 0, [0, 7]),
    replace(2, 0, []),
    replace(2, 1),
    reply(2, 8, { op: 'replace', start: 0, end: 1 }, [0]),
  ]) {
    const events = [reply(0, 4), bad]
    assert.equal(resolve(events), null)
    assert.equal(projectedReplyTurns({ events, nodes: [2] }).size, 0)
  }
  const events = [reply(0, 4), replace(1, 9), reply(2, 9, { op: 'replace', start: 0, end: 1 }, [0, 1])]
  assert.equal(resolve(events), null)
})

test('后续正常回合结束后，无输入尝试不能继续认领失败输入', () => {
  const start = (seq, turn) => ({ seq, type: 'turn/start', data: { turn } })
  const end = (seq, turn, kind) => ({ seq, type: 'turn/end', data: { turn, reason: { kind } } })
  const input = (seq) => ({
    seq,
    type: 'user/message',
    surfaceOp: 'append',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '输入' }] },
  })
  const failed = [start(0, 2), input(1), end(2, 2, 'error')]
  const retry = [...failed, start(3, 3), reply(4, 3), end(5, 3, 'completed')]
  assert.deepEqual(keptPlayerInputTurns({ events: retry, replyTurns: [3], suppressed: [2] }), [2])
  const later = [...retry, start(6, 4), reply(7, 4), end(8, 4, 'completed')]
  assert.deepEqual(keptPlayerInputTurns({ events: later, replyTurns: [4], suppressed: [2] }), [])
})

test('正文和按钮的故事编号优先服从当前窗口行计划', async () => {
  const { readFile } = await import('node:fs/promises')
  const vm = await import('node:vm')
  const source = await readFile(new URL('../tavern-plugin/src/client/ui/message-frame.js', import.meta.url), 'utf8')
  const start = source.indexOf('function tavernStoryTurnForDshTurn(')
  const end = source.indexOf('function tavernMvuReceiptForTurn(', start)
  const context = vm.createContext({ createSessionViewReader: {} })
  vm.runInContext(source.slice(start, end), context)
  const pick = context.tavernStoryTurnForDshTurn
  const view = {
    regeneratedDshTurns: { 2: 7 },
    transcriptTurns: { 7: { input: 0, reply: 1, story: 3 }, 8: { input: 0, reply: 0 } },
  }
  assert.equal(pick(view, 7), 3)
  assert.equal(pick(view, 8), 0)
  assert.equal(pick({ ...view, transcriptTurns: {} }, 7), 7)
  assert.equal(pick({ ...view, transcriptFrom: 9 }, 7), 2)
  assert.equal(pick({ regeneratedDshTurns: { 2: 7 } }, 7), 2)
})

test('替换端点按 Surface 顺序而非数字大小解释', () => {
  const events = [reply(0, 4), reply(1, 5), replace(2, 0), reply(3, 8, { op: 'replace', start: 2, end: 1 }, [2, 1])]
  assert.deepEqual(resolve(events), { seq: 1, turn: 5 })
})

test('范围外较新的来源不能夺走范围内的正文座位', () => {
  const events = [reply(0, 7), reply(1, 9), reply(2, 10, { op: 'replace', start: 0, end: 0 }, [0, 1])]
  assert.deepEqual(resolve(events), { seq: 0, turn: 7 })
})

// 撤回后撤销：restoreSurface 写 [占位, 原件]，替换范围只有占位，原件在范围外且更旧、排在最后。
test('撤销恢复写出的 [占位, 原件] 来源仍指回原座位', async () => {
  const { Session } = await import('./fixtures/dsh-session-host.mjs')
  const { appendSessionEvent, sessionEvents, surfaceReplacementRange } = await import('../tavern-plugin/lib/domain/session-events.js')
  const { replaceSessionSurface } = await import('../tavern-plugin/lib/domain/session-surface-mutations.js')
  const { restoreSurface } = await import('../tavern-plugin/lib/domain/surface-restoration.js')
  const { createSessionStateView } = await import('../tavern-plugin/lib/domain/chat-session-state.js')
  const model = { kind: 'model', provider: 'p', model: 'm' }
  const session = Session.create('restore-seat')
  const ev = (type, data, intent) => appendSessionEvent(session, type, data, intent)
  const round = (turn, write) => {
    ev('turn/start', { turn })
    ev('step/start', { turn, step: 1 })
    const result = write()
    ev('step/end', { turn, step: 1 })
    ev('turn/end', { turn, reason: { kind: 'completed' } })
    return result
  }
  const body = (turn, id, text) =>
    ev('assistant/message', { turn, step: 1, message: { id, role: 'assistant', content: [{ type: 'text', text }], source: model } }, { surfaceOp: 'append' })
  round(1, () => body(1, 'open', '开场'))
  let input
  const original = round(2, () => {
    input = ev('user/message', { id: 'i2', role: 'user', content: [{ type: 'text', text: '行动' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    return body(2, 'r2', '旧正文')
  })
  const projected = replaceSessionSurface(
    session,
    'assistant/message',
    { turn: 2, step: 1, message: { id: 'tavern-regen:x', role: 'assistant', content: [{ type: 'text', text: '新正文' }], source: { ...model, tavernStoryTurn: 2 } } },
    { start: original.seq, end: original.seq, sourceEventSeqs: [original.seq] },
  )
  const saved = [...session.surface.nodes]
  replaceSessionSurface(
    session,
    'user/message',
    { id: 'tomb', role: 'user', content: [], source: { kind: 'plugin:dsh-tavern-rollback' } },
    { start: input.seq, end: projected.seq, sourceEventSeqs: [input.seq, projected.seq] },
  )
  restoreSurface(session, saved)
  const events = sessionEvents(session)
  const restored = events.findLast((event) => event.data?.message?.id === 'tavern-regen:x')
  const [placeholder, cited] = restored.sourceEventSeqs
  assert.equal(cited, projected.seq, '原件排在最后')
  assert.ok(placeholder > cited, '占位是范围内较新的节点')
  assert.deepEqual(surfaceReplacementRange(restored.surfaceOp), { start: placeholder, end: placeholder })
  const at = (seq) => events.find((event) => event.seq === seq)
  assert.deepEqual(createReplySeatResolver(at)(restored), { seq: original.seq, turn: 2 })
  const view = createSessionStateView({ activity: () => ({ busy: false }), evidence: () => ({ session, events }) })
    .rollback({ id: 'c', sessionId: session.id, mode: 'story', messages: [] }, { session, events })
  assert.equal(view.regeneratedDshTurns[2], 2)
})
