import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveStoryMessage } from '../tavern-plugin/lib/story/message-target.js'
import { legacyMessageUid } from '../tavern-plugin/lib/domain/message-uid.js'
import { retainStoryResults, storyResultHistory } from '../tavern-plugin/lib/story/result-history.js'
import { createChatJournalStore } from '../tavern-plugin/lib/domain/chat-journal-store.js'
import { createChatPersistence } from '../tavern-plugin/lib/domain/chat-persistence.js'

test('UID 精确区分重复轮号，错误、重复或角色不匹配的身份不回落到下标', () => {
  const chat = { messages: [{ role: 'user', messageUid: 'u', text: '输入' },
    { role: 'assistant', turn: 7, messageUid: 'a', text: '甲' },
    { role: 'assistant', turn: 7, messageUid: 'b', text: '乙' }] }
  assert.equal(resolveStoryMessage(chat, { messageUid: 'b', messageIndex: 1 }).index, 2)
  for (const target of [{ messageIndex: 2 }, { messageUid: 'gone', messageIndex: 2 }, { messageUid: 'u' }])
    assert.throws(() => resolveStoryMessage(chat, target), /身份|已变化/)
  assert.throws(() => resolveStoryMessage(chat, { messageUid: 'a' }, { latest: true }), /最新正文/)
  chat.messages.push({ ...chat.messages[2] })
  assert.throws(() => resolveStoryMessage(chat, { messageUid: 'b' }), /已变化/)
})

test('旧身份与结果历史跨真实日志保存及冷读保留，失效 UID 不写入', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-story-uid-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const open = () => createChatPersistence({ store: createChatJournalStore({ dataRoot: root, newConversations: true }) })
  const persistence = open()
  const original = { role: 'assistant', turn: 4, text: '原正文', variables: [{ gold: 9 }] }
  const uid = legacyMessageUid(original, 0)
  const replacement = retainStoryResults(original, { ...original, messageUid: uid, text: '重写正文' })
  const saved = await persistence.write({ id: 'story', messages: [replacement] })
  const cold = await open().read('story')
  assert.equal(resolveStoryMessage(cold, { messageUid: uid }, { latest: true }).message.text, '重写正文')
  assert.deepEqual(storyResultHistory(cold.messages[0]).history.map(row => row.text), ['原正文', '重写正文'])
  assert.deepEqual(cold.messages[0].variables, original.variables)
  await assert.rejects(persistence.update('story', chat => {
    resolveStoryMessage(chat, { messageUid: 'expired', messageIndex: 0 })
    chat.messages = []
    return chat
  }), /已变化/)
  assert.deepEqual(await open().read('story'), saved)
})

test('旧结果缺省 incomplete 等于完整正文，不重复加入相同正文', () => {
  const message = { text: '正文' }
  const history = storyResultHistory(message, [{ seq: 41, text: '正文' }])
  assert.equal(history.history.length, 1)
  assert.equal(history.current, '41')
})

test('手动编辑保留所选结果身份，不作为新生成加入历史', () => {
  const message = { text: '已编辑正文', storyResultId: 'old', storyResults: [{ id: 'old', text: '原正文' }, { id: 'new', text: '重生成正文' }] }
  const result = storyResultHistory(message)
  assert.equal(result.current, 'old')
  assert.equal(result.history.length, 2)
  const legacy = storyResultHistory({ text: '编辑后的旧版正文' }, [{ seq: 41, text: '旧版原文', current: true }])
  assert.equal(legacy.current, '41')
  assert.equal(legacy.history.length, 1)
})

test('两次生成相同正文仍保留两个独立结果', () => {
  const first = { text: '原正文' }
  const second = retainStoryResults(first, { text: '重生成正文' })
  const third = retainStoryResults(second, { text: '重生成正文' })
  assert.deepEqual(storyResultHistory(third).history.map(row => row.text), ['原正文', '重生成正文', '重生成正文'])
  assert.notEqual(second.storyResultId, third.storyResultId)
})
