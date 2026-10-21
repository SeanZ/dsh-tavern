import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeRepairGame, repairEvidence } from './fixtures/native-repair-game.mjs'
import { appendSessionEvent, sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import {
  replaceSessionSurface,
  createSessionSurfaceMutator,
} from '../tavern-plugin/lib/domain/session-surface-mutations.js'
import {
  applyRegenerationProjection,
  clearFailedTurnSurface,
  replayableFailedTurn,
} from '../tavern-plugin/lib/domain/rollback-surface.js'
import { planNativeSurfaceRepair, applyNativeSurfaceRepair } from '../tavern-plugin/lib/domain/native-surface-repair.js'
import { Session } from './fixtures/dsh-session-host.mjs'

const textInput = [{ type: 'text', text: '失败的输入' }]
const imageInput = [{ type: 'image', attachment: { attachmentId: 'failed-photo', mediaType: 'image/png', bytes: 1 } }]
function failed(session, turn, queued = false, content = textInput) {
  const data = {
    id: `failed-${turn}`,
    role: 'user',
    content,
    source: { kind: 'user' },
  }
  if (queued) appendSessionEvent(session, 'user/message', data, { surfaceOp: 'append' })
  appendSessionEvent(session, 'turn/start', { turn })
  if (!queued) appendSessionEvent(session, 'user/message', data, { surfaceOp: 'append' })
  appendSessionEvent(session, 'turn/end', { turn, reason: { kind: 'error', error: { message: '准备失败' } } })
}
function terminal() {
  const { session, chat } = nativeRepairGame()
  const original = sessionEvents(session).find((event) => event.seq === chat.messages.at(-1).nativeAnchor.reply)
  const data = {
    ...original.data,
    message: {
      ...original.data.message,
      id: 'tavern-regen:prior',
      source: { ...original.data.message.source, tavernStoryTurn: 3 },
    },
  }
  const old = replaceSessionSurface(session, 'assistant/message', data, {
    start: original.seq,
    end: original.seq,
    sourceEventSeqs: [original.seq],
  })
  failed(session, 5)
  clearFailedTurnSurface({ session, turn: 5, id: () => 'failed-cleanup' })
  const cleanup = session.surface.nodes.at(-1)
  const projection = {
    data: { ...data, message: { ...data.message, id: 'tavern-regen:restore' } },
    range: { start: old.seq, end: old.seq, sourceEventSeqs: [old.seq] },
  }
  return { session, chat, cleanup, projection }
}

test('末轮恢复只替换原正文，独立失败清理节点不进入正文范围', () => {
  const { session, cleanup, projection } = terminal()
  applyRegenerationProjection(session, projection)
  const event = sessionEvents(session).findLast((event) => event.data?.message?.id === projection.data.message.id)
  assert.deepEqual(event.sourceEventSeqs, projection.range.sourceEventSeqs)
  assert.ok(session.surface.nodes.includes(cleanup))
  const cold = Session.fromRestore(session.id, JSON.parse(JSON.stringify(sessionEvents(session))))
  const count = sessionEvents(cold).length
  applyRegenerationProjection(cold, projection)
  assert.equal(sessionEvents(cold).length, count)
})

test('旧恢复投影已经扩大范围并写完，冷读后重试可确认完成', () => {
  const { session, projection } = terminal()
  const surface = createSessionSurfaceMutator(session)
  surface.editStep(() => {
    const copy = surface.append('assistant/message', projection.data, { surfaceOp: 'append' })
    const from = session.surface.nodes.indexOf(projection.range.start)
    surface.replace('assistant/message', projection.data, {
      start: projection.range.start,
      end: copy.seq,
      sourceEventSeqs: session.surface.nodes.slice(from),
    })
  })
  const cold = Session.fromRestore(session.id, JSON.parse(JSON.stringify(sessionEvents(session))))
  const count = sessionEvents(cold).length
  applyRegenerationProjection(cold, projection)
  assert.equal(sessionEvents(cold).length, count)
})

test('准备阶段失败的排队输入能重放，不能丢失在 turn/start 之前', () => {
  const { session } = nativeRepairGame()
  failed(session, 4, true)
  assert.equal(replayableFailedTurn({ events: sessionEvents(session) })?.userText, '失败的输入')
})

for (const [label, content] of [
  ['文字', textInput],
  ['只有图片的', imageInput],
])
  test(`末尾存在${label}失败输入时修复前轮正文应延后，不能吞掉失败输入`, () => {
    const { session, chat } = nativeRepairGame()
    failed(session, 4, false, content)
    chat.messages.at(-1).text = '需要修复的正文'
    const cold = Session.fromRestore(session.id, JSON.parse(JSON.stringify(sessionEvents(session))))
    for (const current of [session, cold]) {
      const count = sessionEvents(current).length
      const plan = planNativeSurfaceRepair({ chat, ...repairEvidence(current) })
      assert.equal(plan.status, 'deferred')
      assert.equal(applyNativeSurfaceRepair(current, chat, plan, { repairId: 'deferred' }).applied, false)
      assert.equal(sessionEvents(current).length, count)
      const replay = replayableFailedTurn({ events: sessionEvents(current) })
      assert.equal(replay?.turn, 4)
      assert.deepEqual(replay?.inputAttachments ?? [], content === imageInput ? imageInput : [])
    }
  })

test('排队输入的失败清理覆盖输入本身，前一轮正文保持', () => {
  const { session, chat } = nativeRepairGame()
  failed(session, 4, true)
  const input = sessionEvents(session).find((event) => event.data?.id === 'failed-4')
  const oldReply = chat.messages.at(-1).nativeAnchor.reply
  assert.ok(clearFailedTurnSurface({ session, turn: 4 }) > 0)
  assert.ok(!session.surface.nodes.includes(input.seq))
  assert.ok(session.surface.nodes.includes(oldReply))
  const count = sessionEvents(session).length
  assert.equal(clearFailedTurnSurface({ session, turn: 4 }), 0)
  assert.equal(sessionEvents(session).length, count)
  Session.fromRestore(session.id, JSON.parse(JSON.stringify(sessionEvents(session))))
})

test('打开的生成步骤中不执行多轮修复，关闭并清理后才能恢复', () => {
  const { session, chat } = nativeRepairGame()
  appendSessionEvent(session, 'turn/start', { turn: 4 })
  appendSessionEvent(session, 'step/start', { turn: 4, step: 1 })
  chat.messages.at(-1).text = '新正文'
  const count = sessionEvents(session).length
  const plan = planNativeSurfaceRepair({ chat, ...repairEvidence(session) })
  assert.equal(plan.status, 'deferred')
  assert.equal(applyNativeSurfaceRepair(session, chat, plan, { repairId: 'running' }).applied, false)
  assert.equal(sessionEvents(session).length, count)
  appendSessionEvent(session, 'step/end', { turn: 4, step: 1 })
  appendSessionEvent(session, 'turn/end', { turn: 4, reason: { kind: 'completed' } })
  const ready = planNativeSurfaceRepair({ chat, ...repairEvidence(session) })
  assert.equal(applyNativeSurfaceRepair(session, chat, ready, { repairId: 'closed' }).applied, true)
})
