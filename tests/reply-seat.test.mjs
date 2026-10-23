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
