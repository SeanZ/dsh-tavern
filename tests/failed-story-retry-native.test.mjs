import assert from 'node:assert/strict'
import test from 'node:test'
import { createInitializationNative } from './fixtures/conversation-initialization-native.mjs'
import { createForegroundHandoff } from '../tavern-plugin/lib/domain/foreground-handoff.js'
import { createRoundHistory } from '../tavern-plugin/lib/domain/round-history.js'
import { createStoryTimeline } from '../tavern-plugin/lib/domain/story-timeline.js'
import { clearFailedTurnSurface } from '../tavern-plugin/lib/domain/rollback-surface.js'
import { sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import { createPlayHandlers } from '../tavern-plugin/lib/rpc/play.js'
import { createTurnOrchestrator } from '../tavern-plugin/lib/domain/turn-orchestration.js'

async function failedOpening(t) {
  let failing = true
  let waitForModel
  const requests = []
  const host = await createInitializationNative(process.env.DSH_BOOT_MODULE, {
    async *modelStream(input) {
      requests.push(input.messages)
      if (waitForModel) await waitForModel()
      if (failing) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PI_AI_ERROR', message: '合成模型暂不可用' } } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '重试后正文' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })
  t.after(() => host.dispose())
  const opening = await host.open().start(host.input)
  const chatId = opening.id
  const persistence = host.persistence
  const { agent, session } = host.target
  const greeting = opening.messages[0].text
  const text = '推开石门'
  const source = { kind: 'user', rpcId: 'retry-player-request' }
  agent.followup({ id: 'first-input', role: 'user', content: [{ type: 'text', text }], source })
  await agent.whenIdle().catch(() => {})
  const failed = sessionEvents(session).findLast(event => event.type === 'turn/end')
  assert.equal(failed.data.reason.kind, 'error')
  assert.ok(requests.length > 0)
  requests.length = 0
  const systemHead = session.surface.nodes[0]
  assert.equal(session.eventAt(systemHead).type, 'system/message')
  const turn = failed.data.turn
  assert.ok(turn > 1, '真实开场先建立系统头和正文')
  const input = { role: 'user', text, sourceText: text, source, native: true, messageUid: 'stable-user-uid' }
  await persistence.update(chatId, chat => ({ ...chat, messages: [
    chat.messages[0], { ...input, placeholder: true }, { role: 'assistant', turn, placeholder: true, text: '' }
  ] }))
  const failurePublished = Promise.withResolvers(), releaseDiscard = Promise.withResolvers()
  t.after(() => releaseDiscard.resolve())
  const forSession = () => persistence.read(chatId)
  const turns = createTurnOrchestrator({
    store: { chatForSession: forSession, updateChat: persistence.update, writeChat: persistence.write },
    frameBuilder: { build() {} }
  })
  const handoff = createForegroundHandoff({
    store: { chatForSession: forSession },
    tasks: { activity: () => ({}) }, queueBackground: async () => {},
    turns: {
      async finalize() {},
      async recordFailure(target) {
        if (target.turn !== turn) return turns.recordFailure(target)
        await persistence.update(chatId, chat => ({ ...chat, foregroundError: { turn } }))
        failurePublished.resolve()
      },
      async discard(target) {
        if (target.turn !== turn) return turns.discard(target)
        await releaseDiscard.promise
        await persistence.update(chatId, chat => ({ ...chat, messages: [chat.messages[0], input] }))
      },
    },
    async cleanupFailedTurn(target) { clearFailedTurnSurface({ session, turn: target.turn }); await host.checkpoint() }
  })
  host.ctx.on('session/event', (current, event) => {
    if (event.type === 'turn/end') handoff.end({ sessionId: current.id, turn: event.data.turn, reason: event.data.reason.kind })
  })
  handoff.end({ sessionId: session.id, turn, reason: 'error' })
  await failurePublished.promise
  const history = createRoundHistory({
    chats: {
      read: persistence.read, forSession, readCard: async () => ({ name: '合成卡' }),
      update: persistence.update,
      readRecent: async id => (await persistence.readWindow(id, { limit: 2 }))?.chat
    },
    sessions: { get: () => agent, flush: () => host.checkpoint() },
    scripts: {}, timeline: createStoryTimeline(), queueSettlement: async () => {},
    prepareRegenerationFrame: async input => ({ frame: {
      kind: 'foreground', contributions: [], userInput: { sourceText: input.userText, projectedText: input.userText }
    } }),
    present: chat => structuredClone(chat)
  })
  const started = Promise.withResolvers()
  const handlers = createPlayHandlers({
    str: value => value ?? '', autoChoices: { cancel() {} },
    reconcileStory: () => assert.fail('失败重试须在清理后读取权威存档'),
    waitForDiscard: sessionId => { started.resolve(); return handoff.waitForDiscard(sessionId) },
    regenBody: history.regenerate,
    polishPrereview: { cancel() {}, start: async () => {} }, notifyPluginTimeline() {}
  })
  return { host, session, chatId, greeting, text, input, source, requests, forSession, releaseDiscard, started, turns,
    succeed() { failing = false }, pauseModel(callback) { waitForModel = callback },
    retry: () => handlers.regenBody({ sessionId: session.id, guidance: '', retryFailedTurn: turn }) }
}

const nativeTest = { skip: !process.env.DSH_BOOT_MODULE, timeout: 30000 }

test('真实 DSH 首轮失败后，重试等待占位清理并用原输入向模型补写正文', nativeTest, async t => {
  const { host, session, chatId, greeting, text, input, source, requests, forSession, releaseDiscard, started, succeed, retry } = await failedOpening(t)
  succeed()
  const resultPending = retry()
  await started.promise
  assert.equal((await forSession()).messages.at(-1).placeholder, true)
  assert.equal(requests.length, 0, '旧失败占位仍在时不会发请求')
  releaseDiscard.resolve()
  const result = await resultPending
  assert.equal(requests.length, 1)
  assert.equal(session.eventAt(session.surface.nodes[0]).type, 'system/message')
  assert.equal(requests[0].filter(message => message.role === 'user'
    && message.content.some(part => part.type === 'text' && part.text === text)).length, 1)
  host.open()
  const cold = await host.persistence.read(chatId)
  assert.equal(result.view.messages.at(-1).text, '重试后正文')
  assert.deepEqual(cold.messages.map(message => message.text), [greeting, text, '重试后正文'])
  assert.equal(cold.messages[1].messageUid, input.messageUid)
  assert.deepEqual(cold.messages[1].source, source)
  assert.equal(cold.foregroundError, null)
})

test('真实 DSH 重试期间持久化的新输入不会被重试正文覆盖', nativeTest, async t => {
  const { host, session, chatId, greeting, text, input, requests, forSession, releaseDiscard, succeed, pauseModel, retry, turns } = await failedOpening(t)
  const modelStarted = Promise.withResolvers(), releaseModel = Promise.withResolvers()
  t.after(() => releaseModel.resolve())
  pauseModel(() => { modelStarted.resolve(); return releaseModel.promise })
  succeed()
  releaseDiscard.resolve()
  const pending = assert.rejects(retry(), /重新生成期间历史消息已经变化/)
  await modelStarted.promise
  const newer = '推门后喊了一声'
  const requestId = 'new-player-request'
  assert.equal((await turns.appendUser({ sessionId: session.id, requestId, userText: newer })).saved, true)
  assert.equal((await forSession()).messages.at(-1).text, newer)
  releaseModel.resolve()
  await pending
  assert.equal(requests.length, 1)
  host.open()
  const cold = await host.persistence.read(chatId)
  assert.deepEqual(cold.messages.map(message => message.text), [greeting, text, newer])
  assert.equal(cold.messages[1].messageUid, input.messageUid)
  assert.equal(cold.messages.at(-1).source.rpcId, requestId)
  assert.equal(cold.messages.at(-1).placeholder, true)
  assert.equal(cold.regenInProgress, undefined)
})

test('真实 DSH 补写也失败时，同一玩家输入可以再次重试', nativeTest, async t => {
  const { host, session, chatId, greeting, text, input, source, requests, releaseDiscard, succeed, retry } = await failedOpening(t)
  const originalTurn = sessionEvents(session).findLast(event => event.type === 'turn/end').data.turn
  releaseDiscard.resolve()
  await assert.rejects(retry(), /这次重新生成没有完成/)
  assert.ok(requests.length > 0)
  const retryFailure = sessionEvents(session).findLast(event => event.type === 'turn/end').data
  assert.equal(retryFailure.reason.kind, 'error')
  assert.ok(retryFailure.turn > originalTurn)
  requests.length = 0
  succeed()
  await retry()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].filter(message => message.role === 'user'
    && message.content.some(part => part.type === 'text' && part.text === text)).length, 1)
  host.open()
  const cold = await host.persistence.read(chatId)
  assert.deepEqual(cold.messages.map(message => message.text), [greeting, text, '重试后正文'])
  assert.equal(cold.messages[1].messageUid, input.messageUid)
  assert.deepEqual(cold.messages[1].source, source)
  assert.equal(cold.foregroundError, null)
})
