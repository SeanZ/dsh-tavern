import assert from 'node:assert/strict'
import test from 'node:test'
import { createInitializationNative } from './fixtures/conversation-initialization-native.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProfileDataStore } from '../tavern-plugin/lib/profile-data-store.js'
import { createFloorSnapshots } from '../tavern-plugin/lib/story/floor-snapshots.js'
import { createStoryRoundsFold, foldStoryRounds } from '../tavern-plugin/lib/story/story-rounds.js'
import { sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import { createBodyEditor } from '../tavern-plugin/lib/domain/body-editor.js'
import { projectReplyLayers } from '../tavern-plugin/lib/domain/reply-presentation.js'
import { createStoryTimeline } from '../tavern-plugin/lib/domain/story-timeline.js'

test('saved edit survives disk restore and replaces the old body in the next real Agent request', { skip: !process.env.DSH_BOOT_MODULE }, async t => {
  const h = await createInitializationNative(process.env.DSH_BOOT_MODULE)
  t.after(() => h.dispose())
  await h.importHistory({ ...h.input, operationId: 'body-edit-native', text: [{ chat_metadata: {} }, { is_user: false, mes: '开场' }, { is_user: true, mes: '走到花店' }, { is_user: false, mes: '原正文：抵达花店' }].map(JSON.stringify).join('\n') })
  const chat = await h.open().ensureOpening(h.input.sessionId)
  const editor = createBodyEditor({
    chats: { forSession: () => h.persistence.read(chat.id), update: h.persistence.update },
    sessions: { get: () => h.target.agent, flush: () => h.checkpoint() },
    timeline: createStoryTimeline(), activity: () => ({ busy: false }), project: async text => projectReplyLayers(text), present: async chat => chat
  })
  const edit = await editor.read(h.input.sessionId)
  await editor.save(h.input.sessionId, { token: edit.token, texts: ['修改正文：留在邮局'] })
  assert.equal(h.requests.length, 0)
  await h.restoreDetached()
  await h.continueWithAgent()
  assert.equal(h.requests.length, 1)
  const messages = h.requests[0].messages.map(message => message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
  assert.equal(messages.filter(text => text === '修改正文：留在邮局').length, 1)
  assert.equal(messages.filter(text => text.includes('原正文：抵达花店')).length, 0)
  assert.equal((await h.persistence.read(chat.id)).messages.at(-1).text, '修改正文：留在邮局')
})


test('真实 Session 自动精修不推进故事版本，但替换回复身份使冷读旧快照失配，并保留变量未重算标记', { skip: !process.env.DSH_BOOT_MODULE }, async t => {
  const h = await createInitializationNative(process.env.DSH_BOOT_MODULE)
  t.after(() => h.dispose())
  const root = await mkdtemp(join(tmpdir(), 'tavern-polish-snapshot-native-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await h.importHistory({ ...h.input, operationId: 'body-polish-native', text: [{ chat_metadata: {} }, { is_user: false, mes: '开场' }, { is_user: true, mes: '走到花店' }, { is_user: false, mes: '原正文：抵达花店' }].map(JSON.stringify).join('\n') })
  let chat = await h.open().ensureOpening(h.input.sessionId)
  const beforeEvents = sessionEvents(h.target.session)
  const fold = createStoryRoundsFold()
  const lastSeq = beforeEvents.at(-1).seq
  fold.addEvents(beforeEvents)
  const before = fold.result().floors.at(-1)
  assert.equal(before.reply.text, '原正文：抵达花店')
  const oldSeq = before.reply.seq
  const stale = { replySeq: oldSeq }
  chat = await h.persistence.update(chat.id, current => {
    current.messages.at(-1).variablesStale = stale
    return current
  })
  const revision = chat.timeline.revision
  const openSnapshots = () => createFloorSnapshots({ store: createProfileDataStore({ dataRoot: root }), chatIdFor: async () => chat.id })
  await openSnapshots().save({ sessionId: h.input.sessionId, turn: before.story, reply: String(oldSeq), html: '<p>原正文：抵达花店</p>' })
  const editor = createBodyEditor({
    chats: { forSession: () => h.persistence.read(chat.id), update: h.persistence.update },
    sessions: { get: () => h.target.agent, flush: () => h.checkpoint() },
    timeline: createStoryTimeline(), activity: () => ({ busy: false }), project: async text => projectReplyLayers(text), present: async chat => chat
  })
  const edit = await editor.read(h.input.sessionId)
  await editor.polish(h.input.sessionId, { token: edit.token, texts: ['精修正文：缓步抵达花店'] })
  const saved = await h.persistence.read(chat.id)
  assert.equal(saved.timeline.revision, revision, '精修不改变故事版本号')
  assert.deepEqual(saved.messages.at(-1).variablesStale, stale, '精修不能冒充变量重算')
  const events = sessionEvents(h.target.session)
  const replacement = events.find(event => event.type === 'assistant/message' && event.data?.message?.id === saved.messages.at(-1).bodyEdit.id)
  assert.ok(replacement.seq > oldSeq, '正式 synchronizeBodyEdits 必须写入新的原生事件')
  assert.equal(h.target.session.surface.nodes.includes(oldSeq), false)
  assert.equal(h.target.session.surface.nodes.includes(replacement.seq), true)
  fold.addEvents(events.filter(event => event.seq > lastSeq))
  const after = fold.result().floors.at(-1)
  assert.equal(after.story, before.story)
  assert.equal(after.reply.seq, replacement.seq)
  assert.equal(after.reply.text, '精修正文：缓步抵达花店')
  assert.equal(after.reply.id, saved.messages.at(-1).bodyEdit.id)
  await h.restoreDetached()
  const cold = foldStoryRounds(sessionEvents(h.target.session)).floors.at(-1)
  assert.deepEqual(cold.reply, after.reply, '从落盘事件冷读也必须取得精修后的回复身份')
  const snapshot = (await openSnapshots().read({ sessionId: h.input.sessionId })).snapshots[cold.story]
  assert.equal(snapshot.reply, String(oldSeq), '旧快照仍保留它真实的来源')
  assert.notEqual(snapshot.reply, String(cold.reply.seq), '楼层快照的 reply/seq 匹配契约拒绝旧正文')
  assert.deepEqual((await h.persistence.read(chat.id)).messages.at(-1).variablesStale, stale)
  assert.equal(h.requests.length, 0, '编辑与冷读不应调用模型')
})
