import test from 'node:test'
import assert from 'node:assert/strict'
import {
  conversationStateAtTurn,
  conversationForkBoundary,
} from '../tavern-plugin/lib/domain/conversation-fork-point.js'
import { forkTurnsByMessageId } from '../tavern-plugin/lib/domain/conversation-fork-targets.js'
import { planTranscriptRows } from '../tavern-plugin/lib/domain/transcript-row-plan.js'
import { nativeRepairGame } from './fixtures/native-repair-game.mjs'
import { appendSessionEvent, sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import {
  applyRegenerationProjection,
  planRegenerationSurface,
  regenerationProjection,
} from '../tavern-plugin/lib/domain/rollback-surface.js'
import { Session, buildForkSeed } from './fixtures/dsh-session-host.mjs'
import { forkConversationChat } from '../tavern-plugin/lib/domain/conversation-fork.js'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const messages = (turn, text = `正文${turn}`) => [
  { role: 'user', text: '输入' },
  { role: 'assistant', turn, text },
]

test('重生成历史按原生 checkpoint 坐标回溯，保留目标故事的完整状态', async () => {
  const wanted = {
    id: 'chat',
    mode: 'story',
    _storageRevision: 135,
    settleStatus: 'done',
    messages: messages(12),
    variables: { hp: 7 },
    regeneratedDshTurns: { 12: 13 },
  }
  const source = {
    ...wanted,
    _storageRevision: 200,
    messages: [...wanted.messages, ...messages(14)],
    timeline: {
      checkpoints: [
        { turn: 13, beforeRevision: 123 },
        { turn: 14, beforeRevision: 135 },
      ],
    },
  }
  const reads = []
  const result = await conversationStateAtTurn(source, 12, async (_id, revision) => {
    reads.push(revision)
    return revision === 135 ? structuredClone(wanted) : { ...wanted, _storageRevision: 123, messages: messages(11) }
  })
  assert.deepEqual(reads, [135])
  assert.deepEqual(result.state.variables, { hp: 7 })
})

function regenerate(session, chat, oldSeq, native, body) {
  const eventStart = sessionEvents(session).length
  appendSessionEvent(session, 'turn/start', { turn: native })
  appendSessionEvent(session, 'step/start', { turn: native, step: 1 })
  appendSessionEvent(
    session,
    'user/message',
    {
      id: `regen-${native}`,
      role: 'user',
      source: { kind: 'plugin:dsh-tavern-regen' },
      content: [{ type: 'text', text: '重生成' }],
    },
    { surfaceOp: 'append' },
  )
  appendSessionEvent(
    session,
    'assistant/message',
    {
      turn: native,
      step: 1,
      message: {
        id: `reply-${native}`,
        role: 'assistant',
        source: { kind: 'model', provider: 'test', model: 'test' },
        content: [{ type: 'text', text: body }],
      },
    },
    { surfaceOp: 'append' },
  )
  appendSessionEvent(session, 'step/end', { turn: native, step: 1 })
  appendSessionEvent(session, 'turn/end', { turn: native, reason: { kind: 'completed' } })
  const plan = planRegenerationSurface({
    events: sessionEvents(session),
    nodes: session.surface.nodes,
    oldAssistantSeq: oldSeq,
    eventStart,
  })
  applyRegenerationProjection(
    session,
    regenerationProjection(
      plan,
      {
        turn: 3,
        step: 1,
        message: {
          id: `tavern-regen:${native}`,
          role: 'assistant',
          source: { kind: 'model', provider: 'test', model: 'test', tavernStoryTurn: 3 },
          content: [{ type: 'text', text: body }],
        },
      },
      `op-${native}`,
    ),
  )
  chat.messages.at(-1).text = body
  chat.regeneratedDshTurns = { 3: native }
  chat.settleStatus = 'done'
  return sessionEvents(session).findLast((event) => event.data?.message?.id === `tavern-regen:${native}`).seq
}

test('真实 Session 连续重生成的分叉边界包含投影编辑轮且可冷读', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'regenerated-fork-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { session, chat } = nativeRepairGame()
  let seq = chat.messages.at(-1).nativeAnchor.reply
  for (const native of [4, 6]) {
    seq = regenerate(session, chat, seq, native, `重生成${native}`)
    const boundary = conversationForkBoundary(session, chat, 3)
    assert.equal(boundary, sessionEvents(session).at(-1).seq)
    const sourceBefore = JSON.stringify(sessionEvents(session))
    const child = Session.create(
      `fork-${native}`,
      buildForkSeed(sessionEvents(session), boundary),
      { ...session.header, id: `fork-${native}`, isSeeded: true, parentSession: session.id },
      boundary + 1,
    )
    const path = join(root, `fork-${native}.jsonl`)
    await writeFile(
      path,
      sessionEvents(child)
        .map((event) => JSON.stringify(event))
        .join('\n'),
    )
    const cold = Session.fromRestore(
      child.id,
      (await readFile(path, 'utf8')).split('\n').map((line) => JSON.parse(line)),
      child.header,
      boundary + 1,
    )
    assert.match(JSON.stringify(cold.deriveMessages()), new RegExp(`重生成${native}`))
    assert.equal(JSON.stringify(sessionEvents(session)), sourceBefore)
    const fork = forkConversationChat(chat, {
      chatId: `fork-${native}`,
      sessionId: cold.id,
      id: (prefix) => `${prefix}-fork`,
      lastNativeTurn: native + 1,
    })
    assert.equal(fork.regeneratedDshTurns['3'], native)
    const turns = planTranscriptRows({ chat, events: sessionEvents(session) })
    const targets = forkTurnsByMessageId(session, chat.regeneratedDshTurns, { turns, from: null })
    assert.equal(targets[`reply-${native}`], 3)
    assert.equal(targets[`tavern-regen:${native}`], 3)
  }
})

test('投影编辑前插入其他故事输入不能扩大历史分叉边界', () => {
  const { session, chat } = nativeRepairGame()
  regenerate(session, chat, chat.messages.at(-1).nativeAnchor.reply, 4, '重生成正文')
  const events = structuredClone(sessionEvents(session))
  const editStart = events.findIndex((event) => event.type === 'turn/start' && event.data.turn === 5)
  events.splice(editStart + 1, 0, {
    seq: -1,
    type: 'user/message',
    surfaceOp: 'append',
    data: { id: 'foreign', role: 'user', content: [{ type: 'text', text: '别的故事' }], source: { kind: 'user' } },
  })
  events.forEach((event, seq) => {
    event.seq = seq
  })
  assert.throws(() => conversationForkBoundary({ events }, chat, 3), /后续上下文|边界/)
})

test('原生编辑轮失败、未结束或有模型调用时拒绝历史分叉', () => {
  for (const mode of ['failed', 'open', 'model-call']) {
    const { session, chat } = nativeRepairGame()
    regenerate(session, chat, chat.messages.at(-1).nativeAnchor.reply, 4, '新正文')
    const events = structuredClone(sessionEvents(session))
    if (mode === 'failed') events.at(-1).data.reason.kind = 'error'
    if (mode === 'open') events.pop()
    if (mode === 'model-call') {
      const at = events.findIndex((event) => event.type === 'step/start' && event.data.turn === 5)
      events.splice(at + 1, 0, { seq: -1, type: 'model/request', data: { turn: 5 } })
      events.forEach((event, seq) => {
        event.seq = seq
      })
    }
    assert.throws(() => conversationForkBoundary({ events }, chat, 3), /后续上下文|边界/)
  }
})
