import test from 'node:test'
import assert from 'node:assert/strict'
import { createStoryTranscriptReader } from '../tavern-plugin/lib/domain/story-transcript-reader.js'

const header = { id: 'chat', sessionId: 'session', mode: 'story', backgroundConfigVersion: 1 }
const summary = message => ({ role: message.role, turn: message.turn, greeting: message.greeting })

function fixture(messages, { paged = true, revision = 7 } = {}) {
  const state = { messages: messages.map(message => ({ ...message })), revision, summariesCalled: 0, fullReads: 0 }
  const window = (before, limit) => {
    const end = before ?? state.messages.length
    const from = Math.max(0, end - limit)
    return {
      chat: { ...header, _storageRevision: state.revision, messages: state.messages.slice(from, end).map(message => ({ ...message })) },
      from, to: end - 1, messageCount: state.messages.length, revision: state.revision
    }
  }
  const reader = createStoryTranscriptReader({
    readSessionMap: async () => ({ session: 'chat' }),
    readWindow: async (_chatId, options = {}) => {
      if (!paged) return null
      if (options.revision !== undefined && options.revision !== state.revision) return null
      return window(options.before, options.limit)
    },
    readRecentSummaries: async (_chatId, count, options = {}) => {
      state.summariesCalled++
      if (options.revision !== state.revision) return null
      return { from: 0, messageCount: state.messages.length, messages: state.messages.map(summary), revision: state.revision }
    },
    readChat: async () => {
      state.fullReads++
      return { ...header, _storageRevision: state.revision, messages: state.messages.map(message => ({ ...message })) }
    },
    messageFields: ['role', 'turn', 'text'],
    limit: 3
  })
  return { reader, state }
}

const history = [
  { role: 'assistant', greeting: true, turn: 1, text: '开场' },
  { role: 'user', text: '一' },
  { role: 'assistant', turn: 12, text: '正文一' },
  { role: 'user', text: '二' },
  { role: 'assistant', text: '无编号正文' },
  { role: 'assistant', turn: 12, text: '重复编号正文' }
]

test('分页故事首屏只取窗口正文，楼层与全历史顺序一致', async () => {
  const { reader, state } = fixture(history)
  const result = await reader('session')
  assert.equal(result.from, 3)
  assert.equal(result.to, 5)
  assert.equal(result.chat.messages.length, 3)
  assert.equal(result.storyTranscript.floorCount, 4)
  assert.equal(result.storyTranscript.floorOffset, 2)
  assert.deepEqual(result.storyTranscript.messages.map(row => [row.absoluteIndex, row.floorNo, row.key]), [
    [3, null, 'index:3'],
    [4, 3, 'index:4'],
    [5, 4, 'index:5']
  ])
  assert.equal(state.fullReads, 0)
  assert.equal(state.summariesCalled, 1)
})

test('旧存储读取一次完整 Chat，缺 turn 与重复 turn 无需迁移', async () => {
  const { reader, state } = fixture(history, { paged: false })
  const result = await reader('session')
  assert.equal(result.from, 0)
  assert.equal(result.to, history.length - 1)
  assert.equal(result.storyTranscript.floorCount, 4)
  assert.deepEqual(result.storyTranscript.messages.map(row => row.floorNo), [1, null, 2, null, 3, 4])
  assert.equal(state.fullReads, 1)
  assert.equal(state.summariesCalled, 0)
})

test('窗口与摘要 revision 竞争时重试，不混合两个版本', async () => {
  const { state } = fixture(history)
  let calls = 0
  const racing = createStoryTranscriptReader({
    readSessionMap: async () => ({ session: 'chat' }),
    readWindow: async (_chatId, options = {}) => {
      const end = options.before ?? state.messages.length
      const from = Math.max(0, end - options.limit)
      return { chat: { ...header, messages: state.messages.slice(from, end) }, from, to: end - 1, messageCount: state.messages.length, revision: state.revision }
    },
    readRecentSummaries: async () => {
      calls++
      return { from: 0, messageCount: state.messages.length, messages: state.messages.map(summary), revision: calls === 1 ? state.revision - 1 : state.revision }
    },
    readChat: async () => { throw new Error('竞争重试成功时不应全量读取') },
    limit: 3
  })
  const result = await racing('session')
  assert.equal(result.storyTranscript.messages.length, 3)
  assert.equal(calls, 2)
})

test('读取目标不是故事会话时返回 null', async () => {
  const { reader } = fixture(history)
  assert.equal(await reader('other-session'), null)
})

for (const paged of [false, true]) test(`真实存档冷读保留 RPC 输入身份、显示模板和结果历史，paged=${paged}`, async t => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createChatJournalStore } = await import('../tavern-plugin/lib/domain/chat-journal-store.js')
  const { createChatPersistence } = await import('../tavern-plugin/lib/domain/chat-persistence.js')
  const { sessionViewMessageFields } = await import('../tavern-plugin/lib/domain/session-view-projection.js')
  const root = await mkdtemp(join(tmpdir(), 'story-transcript-fields-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const persistence = createChatPersistence({ store: createChatJournalStore({ dataRoot: root, newConversations: paged }) })
  const messages = [
    { role: 'assistant', greeting: true, turn: 1, text: '开场' },
    { role: 'user', text: '已中断', source: { kind: 'user', rpcId: 'stopped' } },
    { role: 'user', text: '新输入', source: { kind: 'user', rpcId: 'accepted' }, tavernPluginData: { template_display: { source: '新输入', swipe: 0, html: '<b>新输入</b>' } } },
    { role: 'assistant', turn: 4, text: '回复', storyResults: [{ id: 'result', text: '回复' }], storyResultId: 'result' }
  ]
  await persistence.write({ ...header, messages })
  const cold = createChatPersistence({ store: createChatJournalStore({ dataRoot: root }) })
  const reader = createStoryTranscriptReader({ readSessionMap: async () => ({ session: 'chat' }),
    readWindow: cold.readWindow, readRecentSummaries: cold.readRecentSummaries, readChat: cold.read,
    messageFields: sessionViewMessageFields, limit: 3 })
  const result = await reader('session')
  const rows = result.storyTranscript.messages.map(row => row.message)
  assert.deepEqual(rows.filter(row => row.role === 'user').map(row => row.source.rpcId), ['stopped', 'accepted'])
  assert.equal(rows.find(row => row.text === '新输入').tavernPluginData.template_display.html, '<b>新输入</b>')
  assert.equal(rows.at(-1).storyResultId, 'result')
  assert.equal(rows.at(-1).storyResults.length, 1)
})
