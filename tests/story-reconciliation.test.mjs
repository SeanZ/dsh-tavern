import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from './fixtures/dsh-session-host.mjs'
import { appendSessionEvent, sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import { createStoryReconciliation } from '../tavern-plugin/lib/domain/story-reconciliation.js'
import { replayableFailedTurn } from '../tavern-plugin/lib/domain/rollback-surface.js'
import { nativeOpeningMessageId } from '../tavern-plugin/lib/domain/native-opening.js'

const reply = (id, turn) => ({ turn, step: 1, message: { id, role: 'assistant', content: [{ type: 'text', text: id }], source: { kind: 'model', provider: 'test', model: 'test' } } })

function harness({ chat, session = Session.create('story'), agent = null } = {}) {
  const reads = [], writes = []
  let saved = structuredClone(chat)
  const service = createStoryReconciliation({
    agentRegistry: new Map(agent ? [['story', agent]] : []),
    sessionStore: Object.assign(new Map([['story', session]]), { flush: async () => { writes.push('flush') } }),
    chatForSession: async id => { reads.push(id); return id === 'story' ? structuredClone(saved) : undefined },
    chatSliceForSession: async () => null,
    async updateChat(id, mutate, options) { const next = mutate(structuredClone(saved)); writes.push(options.source); if (next) saved = next; return saved },
    turns: { finalize: async () => assert.fail('nothing to adopt') }
  })
  return { service, session, reads, writes, saved: () => saved }
}

test('concurrent reconciles share one run, and once-only reconciles stop after a report', async () => {
  // A regeneration in progress reports without repairing, so the run needs no native rounds.
  const h = harness({ chat: { id: 'game', mode: 'story', regenInProgress: true, messages: [] } })
  appendSessionEvent(h.session, 'assistant/message', reply('tavern-opening:x', 1), { surfaceOp: 'append' })
  const [first, second] = await Promise.all([h.service.reconcileWhenIdle('story'), h.service.reconcileWhenIdle('story')])
  assert.equal(first.state, 'regenerating')
  assert.equal(second, first, 'the second caller awaits the same run')
  assert.equal(h.reads.length, 1)
  assert.equal(await h.service.reconcileWhenIdle('story', { once: true }), null)
  assert.equal(h.reads.length, 1, 'a session already reconciled is not read again')
  assert.deepEqual(h.writes, [])
})

// seedNativeStory 是修复写入的唯一生产入口：只在故事分叉的空白 Session 上按存档建立原生上下文。
const forkSave = () => ({ id: 'fork', mode: 'story', nativeSync: { status: 'stale', reason: '故事分叉等待原生上下文同步' },
  messages: [{ role: 'assistant', turn: 1, greeting: true, text: '开场' }, { role: 'user', text: '行动2' }, { role: 'assistant', turn: 2, text: '正文2' }] })
const textInput = [{ type: 'text', text: '失败的输入' }]
const imageInput = [{ type: 'image', attachment: { attachmentId: 'failed-photo', mediaType: 'image/png', bytes: 1 } }]
function failedInput(session, turn, content) {
  appendSessionEvent(session, 'turn/start', { turn })
  appendSessionEvent(session, 'user/message', { id: `failed-${turn}`, role: 'user', content, source: { kind: 'user' } }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'turn/end', { turn, reason: { kind: 'error', error: { message: '准备失败' } } })
}

test('seedNativeStory：空白 Session 按存档整段建立原生上下文，记下锚点并清除待同步标记', async () => {
  const h = harness({ chat: forkSave(), agent: { phase: { kind: 'idle' } } })
  const result = await h.service.seedNativeStory('story', h.session, '测试')
  assert.equal(result.applied, true)
  assert.equal(result.plan.status, 'full')
  const texts = h.session.deriveMessages().map(message => message.content.map(block => block.text).join(''))
  assert.deepEqual(texts, ['开场', '行动2', '正文2'])
  assert.ok(sessionEvents(h.session).some(event => event.data?.message?.id === nativeOpeningMessageId('fork')), '开场白以新局身份写入')
  assert.deepEqual(h.writes, ['flush', 'native-seed'])
  assert.equal(h.saved().nativeSync, undefined)
  assert.ok(h.saved().messages[2].nativeAnchor)
})

for (const [label, content] of [['文字', textInput], ['只有图片的', imageInput]])
  test(`seedNativeStory：目标已有${label}失败输入时拒绝改写，失败输入与附件原样保留可重放`, async () => {
    const h = harness({ chat: forkSave(), agent: { phase: { kind: 'idle' } } })
    failedInput(h.session, 4, content)
    const before = JSON.stringify(sessionEvents(h.session))
    assert.equal(await h.service.seedNativeStory('story', h.session, '测试'), null)
    assert.equal(JSON.stringify(sessionEvents(h.session)), before, '非空目标一个事件都不写')
    assert.deepEqual(h.writes, ['native-repair.stale'])
    assert.equal(h.saved().nativeSync.status, 'stale')
    const replay = replayableFailedTurn({ events: sessionEvents(h.session) })
    assert.equal(replay?.turn, 4)
    assert.equal(replay?.userText, content === textInput ? '失败的输入' : '')
    assert.deepEqual(replay?.inputAttachments ?? [], content === imageInput ? imageInput : [])
  })

test('seedNativeStory：目标会话忙碌或有未结束的生成步骤时拒绝改写', async () => {
  const busy = harness({ chat: forkSave(), agent: { phase: { kind: 'running' } } })
  assert.equal(await busy.service.seedNativeStory('story', busy.session, '测试'), null)
  assert.deepEqual(sessionEvents(busy.session), [])
  assert.deepEqual(busy.writes, ['native-repair.stale'])
  const open = harness({ chat: forkSave(), agent: { phase: { kind: 'idle' } } })
  appendSessionEvent(open.session, 'turn/start', { turn: 4 })
  appendSessionEvent(open.session, 'step/start', { turn: 4, step: 1 })
  const before = JSON.stringify(sessionEvents(open.session))
  assert.equal(await open.service.seedNativeStory('story', open.session, '测试'), null)
  assert.equal(JSON.stringify(sessionEvents(open.session)), before)
  assert.equal(open.saved().nativeSync.status, 'stale')
})
