import assert from 'node:assert/strict'
import test from 'node:test'
import { Session } from './fixtures/dsh-session-host.mjs'
import { createBodyEditor } from '../tavern-plugin/lib/domain/body-editor.js'
import { createRoundHistory } from '../tavern-plugin/lib/domain/round-history.js'
import { createStoryTimeline } from '../tavern-plugin/lib/domain/story-timeline.js'
import { projectRegenerationRequestMessages } from '../tavern-plugin/lib/domain/foreground-orchestration-strategies.js'
import { appendSessionEvent } from '../tavern-plugin/lib/domain/session-events.js'
import { foldStoryRounds } from '../tavern-plugin/lib/story/story-rounds.js'
import { sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'

// 故事视图「编辑并重新生成」（tavernStory.editInput + regenerate）的服务端路径：
// saveUser 用 replace 改掉已完成回合的输入并改存档文字，regenBody 的合成输入取存档文字。
const model = { kind: 'model', provider: 'fixture', model: 'fixture' }
const texts = messages => messages.map(message => (message.content || []).map(block => block.text || '').join(''))

function harness() {
  let counter = 0
  const timeline = createStoryTimeline({ id: prefix => prefix + '-' + (++counter) })
  const session = Session.create('edit-input-regen')
  appendSessionEvent(session, 'turn/start', { turn: 2 })
  appendSessionEvent(session, 'user/message', { id: 'u2', role: 'user', content: [{ type: 'text', text: '推门' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'assistant/message', { turn: 2, step: 1, message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '旧正文' }], source: model } }, { surfaceOp: 'append', sourceEventSeqs: [] })
  appendSessionEvent(session, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  const revisions = new Map()
  let chat = { id: 'chat', sessionId: session.id, mode: 'story', _storageRevision: 1, settleStatus: 'done', posture: '门外', scriptState: { cursor: 0 },
    messages: [{ role: 'assistant', greeting: true, text: '开场', turn: 1 }] }
  revisions.set(1, structuredClone(chat))
  const begun = timeline.apply({ chat, intent: { kind: 'body.begin', turn: 2, userText: '推门' } })
  chat = timeline.complete({ chat: begun.chat, operationId: begun.value.operationId, basedOn: begun.value.basedOn, outcome: { status: 'success' }, apply(draft) {
    draft.messages.push({ role: 'user', text: '推门' }, { role: 'assistant', turn: 2, native: { turn: 2 }, text: '旧正文', sourceText: '旧正文', swipes: ['旧正文'], swipeId: 0 })
  } }).chat
  const requests = []
  const agent = { session, phase: { kind: 'idle', lastTurn: 2 }, followup(message) { agent.input = message }, async whenIdle() {
    const turn = ++agent.phase.lastTurn
    appendSessionEvent(session, 'turn/start', { turn })
    appendSessionEvent(session, 'user/message', agent.input, { surfaceOp: 'append' })
    // 宿主按消息面组请求；Tavern 的请求投影把重生成合成输入换到原玩家输入的位置。
    requests.push(projectRegenerationRequestMessages(session.deriveMessages()))
    const text = '新正文' + turn
    const started = timeline.apply({ chat, intent: { kind: 'body.begin', turn, userText: agent.input.content[0].text } })
    revisions.set(chat._storageRevision, structuredClone(chat))
    chat = timeline.complete({ chat: started.chat, operationId: started.value.operationId, basedOn: started.value.basedOn, outcome: { status: 'success' }, apply(draft) {
      draft.messages.push({ role: 'user', text: agent.input.content[0].text }, { role: 'assistant', turn, text, sourceText: text })
    } }).chat
    appendSessionEvent(session, 'assistant/message', { turn, step: 1, message: { id: 'a' + turn, role: 'assistant', content: [{ type: 'text', text }], source: model } }, { surfaceOp: 'append', sourceEventSeqs: [] })
    appendSessionEvent(session, 'turn/end', { turn, reason: { kind: 'completed' } })
  } }
  const chats = {
    read: async () => structuredClone(chat), forSession: async () => structuredClone(chat), readCard: async () => ({ name: '角色' }),
    readRevision: async (_id, revision) => revisions.get(revision),
    write: async value => { chat = structuredClone(value); return structuredClone(chat) },
    update: async (_id, mutate) => { revisions.set(chat._storageRevision, structuredClone(chat)); chat = await mutate(structuredClone(chat)) ?? chat; chat._storageRevision++; return structuredClone(chat) }
  }
  const sessions = { get: () => agent, flush: async () => {} }
  const editor = createBodyEditor({ chats, sessions, timeline, activity: () => ({ busy: false }), project: async () => ({}), present: async value => value })
  const history = createRoundHistory({ chats, sessions, timeline, scripts: { read: async () => ({ chunks: [] }), continuity: { transition: () => ({ state: { cursor: 0 } }) }, dispatchEvent: async () => {} },
    queueSettlement: async () => {}, present: async value => structuredClone(value) })
  return { session, editor, history, requests, get chat() { return chat }, mark() { chat.messages.at(-1).variablesStale = { replySeq: 3 } } }
}

test('改已完成回合的输入后重新生成：请求里玩家输入是新文字，旧文字不在消息面，楼层随之更新', async () => {
  const h = harness()
  const floor = foldStoryRounds(sessionEvents(h.session)).floors.at(-1)
  const edit = await h.editor.readUser(h.session.id, { turn: floor.inputs[0].turn, seq: floor.inputs[0].seq })
  assert.deepEqual(edit.parts, [{ kind: 'text', text: '推门' }])
  await h.editor.saveUser(h.session.id, { token: edit.token, role: 'user', index: edit.index, turn: edit.turn, seq: edit.seq, texts: ['敲门'] })
  assert.deepEqual(texts(h.session.deriveMessages().filter(message => message.role === 'user')), ['敲门'], '旧输入已被替换出消息面')
  const result = await h.history.regenerate(h.chat.id, '', h.session.id)
  const request = h.requests.at(-1)
  assert.deepEqual(texts(request.filter(message => message.role === 'user')), ['敲门'], '重生成请求里只有改后的输入')
  assert.ok(!JSON.stringify(request).includes('推门'), '旧输入不进请求')
  assert.ok(!JSON.stringify(request).includes('旧正文'), '被重生成的旧正文不进请求')
  assert.equal(result.messages.at(-2).text, '敲门')
  assert.equal(result.messages.at(-1).text, '新正文3')
  const after = foldStoryRounds(sessionEvents(h.session))
  assert.deepEqual(after.floors.map(item => [item.story, item.inputs.map(input => input.text), item.reply.text]), [[2, ['敲门'], '新正文3']])
  assert.ok(!texts(h.session.deriveMessages()).some(text => text.includes('推门')), '之后的请求也看不到旧输入')
})

// 重生成会替换该轮；手动编辑不重算变量，不能提前消除提示。
test('变量未重算标记：重新生成落定后清除，编辑正文后保留', async () => {
  const regen = harness()
  regen.mark()
  await regen.history.regenerate(regen.chat.id, '', regen.session.id)
  assert.equal(regen.chat.messages.at(-1).text, '新正文3')
  assert.equal(Object.hasOwn(regen.chat.messages.at(-1), 'variablesStale'), false)

  const edit = harness()
  edit.mark()
  const stale = structuredClone(edit.chat.messages.at(-1).variablesStale)
  const read = await edit.editor.read(edit.session.id)
  await edit.editor.save(edit.session.id, { token: read.token, texts: ['改过的正文'] })
  assert.match(JSON.stringify(edit.chat.messages.at(-1)), /改过的正文/)
  assert.deepEqual(edit.chat.messages.at(-1).variablesStale, stale)
})
