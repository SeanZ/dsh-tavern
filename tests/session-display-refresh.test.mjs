import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createChatJournalStore } from '../tavern-plugin/lib/domain/chat-journal-store.js'
import { createSessionViewReader } from '../tavern-plugin/lib/domain/session-view-reader.js'
import { createStoryHandlers } from '../tavern-plugin/lib/rpc/story.js'
import { projectionFixture } from './fixtures/session-view-projection.mjs'

async function files(root, prefix = '') {
  const result = {}
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name)
    if (entry.isDirectory()) Object.assign(result, await files(root, path))
    else result[path] = createHash('sha256').update(await readFile(join(root, path))).digest('hex')
  }
  return result
}

test('真实存档经RPC刷新同版本空缓存，磁盘和另一会话投影保持', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-display-refresh-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createChatJournalStore({ dataRoot: root })
  const f = projectionFixture()
  const chat = { ...f.chat, variables: { 计数: 7 }, messages: [
    ...f.chat.messages, { role: 'user', text: '看看窗外' },
    { role: 'assistant', turn: 6, text: '窗外很安静。', sourceText: '窗外很安静。',
      tavernPluginData: { template_display: { source: '窗外很安静。', swipe: 0, formattingText: '窗外很安静。' } } }
  ] }
  await store.update('c', () => chat)
  await store.update('other', () => ({ ...chat, id: 'other', sessionId: 'other' }))
  const ids = { s: 'c', other: 'other' }
  let damaged = true
  const fullRead = async id => {
    const value = await store.read(ids[id])
    return damaged && id === 's' ? { ...value, messages: value.messages.map(row => ({ role: row.role, turn: row.turn })) } : value
  }
  const reader = createSessionViewReader({
    readState: id => store.readSessionState(ids[id]), readChat: fullRead,
    readRefreshChat: id => store.read(ids[id]), readRefreshState: id => store.readSessionState(ids[id]),
    readChanges: store.readChangedIndices, readViewDelta: store.readViewDelta,
    project: f.projection.project, activity: () => ({ busy: false }), foregroundRunning: () => false,
    trace: { stage: (_name, work) => work(), state() {} }, synchronize: (_id, view) => ({ view })
  })
  const empty = await reader.read('s')
  assert.ok(empty.replyProjections.every(row => row.text === ''))
  damaged = false
  assert.ok((await reader.read('s')).replyProjections.every(row => row.text === ''))
  const other = await reader.read('other')
  const before = await files(root)
  const saved = await store.read('c')
  const handlers = createStoryHandlers({ refreshDisplay: id => reader.refresh(id) })
  f.calls.length = 0
  const result = await handlers.refreshSessionDisplay({ sessionId: 's' })
  assert.deepEqual(result.view.replyProjections.map(row => [row.turn, row.text]), [[1, '开场白'], [6, '窗外很安静。']])
  assert.equal((await reader.read('other')).replyProjections, other.replyProjections)
  assert.deepEqual(await store.read('c'), saved)
  assert.deepEqual(await files(root), before)
  assert.deepEqual(f.calls, [])
  await assert.rejects(handlers.refreshSessionDisplay({}), /sessionId/)
})
