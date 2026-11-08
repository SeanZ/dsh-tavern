import { compactedHistoryWarning } from '../tavern-plugin/lib/domain/rollback-compaction.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createInitializationNative } from './fixtures/conversation-initialization-native.mjs'
import { sessionEvents, appendSessionEvent } from '../tavern-plugin/lib/domain/session-events.js'
import { createRoundHistory } from '../tavern-plugin/lib/domain/round-history.js'
import { createStoryTimeline } from '../tavern-plugin/lib/domain/story-timeline.js'
import { createPlayHandlers } from '../tavern-plugin/lib/rpc/play.js'
import { createStoryReconciliation } from '../tavern-plugin/lib/domain/story-reconciliation.js'
import { foldStoryRounds, createStoryRoundsFold } from '../tavern-plugin/lib/story/story-rounds.js'
import { createStoryLifecycle } from '../tavern-plugin/lib/story/service.js'

const native = { skip: !process.env.DSH_BOOT_MODULE, timeout: 30000 }

test('真实压缩、存档与回退RPC：跨摘要拒绝无写入，未压缩尾部可撤回及撤销，冷读保持', native, async t => {
  const h = await createInitializationNative(process.env.DSH_BOOT_MODULE, { contextWindow: 32768 })
  t.after(() => h.dispose())
  const { BasicCompactionEngine } = await import(new URL('../../dsh-compaction-basic/lib/index.js', pathToFileURL(process.env.DSH_BOOT_MODULE)))
  h.open()
  const agent = h.target.agent, session = agent.session
  const play = async turn => {
    agent.followup({ id: 'round-' + turn, role: 'user', content: [{ type: 'text', text: '行动' + turn + '旧事。'.repeat(200) }], source: { kind: 'user' } })
    await agent.whenIdle()
  }
  for (let turn = 1; turn <= 5; turn++) await play(turn)
  assert.ok(await new BasicCompactionEngine(h.ctx, { auto: false, maxTokens: 4096 }).compactNow(agent, new AbortController().signal))
  await play(6)
  await play(7)
  const floors = foldStoryRounds(sessionEvents(session)).floors
  const messages = floors.flatMap((floor, index) => [
    ...(index ? [{ role: 'user', text: floor.inputs.map(input => input.text).join('\n') }] : []),
    { role: 'assistant', turn: floor.story, text: floor.reply.text, ...(index ? {} : { greeting: true }) }
  ])
  await h.persistence.write({ id: 'rollback-native', sessionId: session.id, mode: 'story', messages }, { source: 'create' })
  const read = () => h.persistence.read('rollback-native')
  const reconciliation = createStoryReconciliation({
    agentRegistry: { get: () => agent }, sessionStore: { get: () => session, flush: () => h.checkpoint() },
    chatForSession: read, chatSliceForSession: (_id, indices, fields) => h.persistence.readSlice('rollback-native', indices, fields), updateChat: h.persistence.update
  })
  const rounds = createRoundHistory({
    chats: { read, forSession: read, readState: read, readCard: async () => ({}), readRevision: h.persistence.readRevision, update: h.persistence.update, write: h.persistence.write },
    sessions: { get: () => agent, getSession: () => session, flush: () => h.checkpoint() },
    scripts: { read: async () => undefined, continuity: {}, dispatchEvent: async () => {} },
    timeline: createStoryTimeline(), repairNative: reconciliation.repairNativeStory,
    present: async chat => ({ rollbackTargetTurn: chat.messages.at(-1)?.turn })
  })
  const rpc = createPlayHandlers({ rollbackTurn: rounds.rollback, rollbackToTurn: rounds.rollbackTo, undoRollbackTurn: rounds.undoRollback,
    reconcileStory: reconciliation.reconcileWhenIdle, notifyPluginTimeline() {} })
  const before = await read(), events = structuredClone(sessionEvents(session)), nodes = [...session.surface.nodes]
  await assert.rejects(rpc.rollbackToTurn({ sessionId: session.id, chatId: before.id, turn: 2 }), /压缩摘要/)
  assert.deepEqual(await read(), before, '多层预检拒绝时存档版本也不改变')
  assert.deepEqual(sessionEvents(session), events)
  assert.deepEqual(session.surface.nodes, nodes)
  const folded = createStoryRoundsFold(); folded.addEvents(sessionEvents(session))
  const compactedThrough = folded.compactedStories().at(-1)
  const removed = await rpc.rollbackToTurn({ sessionId: session.id, chatId: before.id, turn: compactedThrough })
  // 最早保留的正文仍在消息面，但其玩家输入可能已进入摘要；不能越过这个半轮边界。
  const boundaryFloor = floors.find(floor => nodes.includes(floor.reply.seq))
  const boundaryInput = events.findLast(event => event.type === 'user/message' && event.seq < boundaryFloor.reply.seq)
  assert.ok(boundaryInput && !nodes.includes(boundaryInput.seq), '边界输入已被真实摘要取代')
  assert.equal(removed.view.rolledBackTo.latest, boundaryFloor.story)
  assert.match(removed.view.rollbackWarning, /已回退.*不能原地回退/)
  assert.ok(removed.view.rolledBackTo.removed >= 2, '真实压缩后撤回多层并验证合并撤销点')
  const after = await read(), afterEvents = structuredClone(sessionEvents(session))
  await assert.rejects(rpc.rollbackTurn({ sessionId: session.id, chatId: before.id, expectedTurn: boundaryFloor.story }), /压缩摘要|不在可回退/)
  assert.deepEqual(await read(), after)
  assert.deepEqual(sessionEvents(session), afterEvents)
  await rounds.undoRollback(session.id, before.id)
  assert.deepEqual((await read()).messages, before.messages)
  const restoredFloors = foldStoryRounds(sessionEvents(session)).floors
  assert.deepEqual(restoredFloors.map(floor => [floor.story, floor.reply.text]), floors.map(floor => [floor.story, floor.reply.text]))
  await h.checkpoint()
  await h.restoreDetached()
  assert.deepEqual(foldStoryRounds(sessionEvents(h.target.session)).floors, restoredFloors)

  // 旧版只隐藏存档轮次时，继续生成必须提示分叉，不能把显示过滤当作上下文已恢复。
  const lifecycle = createStoryLifecycle({ latestChat: async () => ({ ...before, suppressedDshTurns: [floors[2].story] }),
    sessionFor: () => h.target.session, agentFor: () => agent })
  await assert.rejects(lifecycle.rejectStaleTurn({ sessionId: session.id, playerInput: true }), /摘要仍包含已撤回.*分支/)
  await assert.rejects(lifecycle.rejectStaleTurn({ sessionId: session.id, playerInput: false }), /摘要仍包含已撤回.*分支/)
})

for (const kind of ['error', 'regeneration']) test('真实压缩纳入未结算模型文本时不误报撤回：' + kind, native, async t => {
  const h = await createInitializationNative(process.env.DSH_BOOT_MODULE, { contextWindow: 32768 })
  t.after(() => h.dispose())
  const { BasicCompactionEngine } = await import(new URL('../../dsh-compaction-basic/lib/index.js', pathToFileURL(process.env.DSH_BOOT_MODULE)))
  const agent = h.target.agent, session = agent.session
  for (let turn = 1; turn <= 3; turn++) {
    agent.followup({ id: 'normal-' + turn, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '旧剧情'.repeat(200) }] })
    await agent.whenIdle()
  }
  // 构造真实 Session 的多步尝试终态，再交由真实压缩引擎生成检查点。
  // 这里只验证压缩产物与警告判定，不外推为云模型溢出重试已验收。
  for (const turn of [4, 5]) {
    appendSessionEvent(session, 'turn/start', { turn })
    appendSessionEvent(session, 'step/start', { turn, step: 1 })
    appendSessionEvent(session, 'user/message', { id: 'input-' + turn, role: 'user', source: { kind: turn === 4 && kind === 'regeneration' ? 'plugin:dsh-tavern-regen' : 'user' }, content: [{ type: 'text', text: '本轮输入' }] }, { surfaceOp: 'append' })
    appendSessionEvent(session, 'assistant/message', { turn, step: 1, message: { id: 'reply-' + turn, role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: '尝试文本'.repeat(200) }] } }, { surfaceOp: 'append' })
    appendSessionEvent(session, 'step/end', { turn, step: 1 })
    appendSessionEvent(session, 'turn/end', { turn, reason: { kind: turn === 4 && kind === 'error' ? 'error' : 'completed', ...(turn === 4 && kind === 'error' ? { error: { message: '第二步失败' } } : {}) } })
  }
  assert.ok(await new BasicCompactionEngine(h.ctx, { auto: false, maxTokens: 4096 }).compactNow(agent, new AbortController().signal))
  const fold = createStoryRoundsFold(); fold.addEvents(sessionEvents(session))
  assert.ok(fold.compactedStories().includes(4), '实际摘要确实覆盖被抑制的尝试文本')
  assert.equal(compactedHistoryWarning(sessionEvents(session), [4]), '')
})
