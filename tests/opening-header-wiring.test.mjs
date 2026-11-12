import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatJournalStore } from '../tavern-plugin/lib/domain/chat-journal-store.js'
import { createChatPersistence } from '../tavern-plugin/lib/domain/chat-persistence.js'
import { createChatWrites } from '../tavern-plugin/lib/domain/chat-writes.js'

// 执行真实入口的接线，防止独立初始化夹具替换 writeHeader 后漏掉保留字段冲突。
const source = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
const wiring = source.match(/writeHeader: chat => (updateChatHeader\(chat\.id, \['nativeOpeningAppended'[\s\S]+?source: 'opening\.native-append' \}\))/)[1]

test('新局开场标记写入实际日志存储：保留版本字段、正文与其它表头，冷读一致', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-opening-header-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createChatJournalStore({ dataRoot: root, newConversations: true })
  const persistence = createChatPersistence({ store })
  const original = await persistence.write({ id: 'opening', mode: 'story', cardName: '合成卡', messages: [{ role: 'assistant', text: '开场', greeting: true }], variables: { gold: 1 } })
  const writes = [], noop = () => {}
  const chatWrites = createChatWrites({ persistence, isDeleted: () => false, candidatesChanged: noop,
    syncSummary: noop, publish: noop, syncTemplates: noop, queueCompaction: noop,
    observePatch: (_chat, changes) => writes.push(changes) })
  const writeHeader = new Function('updateChatHeader', 'return chat => ' + wiring)(chatWrites.updateHeader)
  const saved = await writeHeader(original)
  assert.equal(saved.nativeOpeningAppended, true)
  assert.equal(saved._storageRevision, original._storageRevision + 1)
  assert.ok(saved.updatedAt >= original.updatedAt)
  assert.deepEqual(writes.map(changes => changes.map(change => change.path)), [[['nativeOpeningAppended']]])
  const cold = await createChatPersistence({ store: createChatJournalStore({ dataRoot: root }) }).read(original.id)
  assert.deepEqual(cold.messages, original.messages)
  assert.deepEqual(cold.variables, original.variables)
  assert.equal(cold.cardName, '合成卡')
  assert.equal(cold.nativeOpeningAppended, true)
})
