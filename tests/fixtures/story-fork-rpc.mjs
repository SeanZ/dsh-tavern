// 从楼层创建分支的真实插件 RPC 场景（tests/story-fork.test.mjs 在独立 DSH_HOME 子进程里运行）。
// 源局用真实宿主 Session 与 Tavern 领域函数玩出（重生成、结果切换、打断墓碑、撤回、失败轮），
// 经 importGameSave 进入真实存储；分叉走现役 UID 路径：客户端 forkAt 把 floor.target
// （messageUid / messageIndex / revision）交给 prepareConversationFork → 宿主新开空白 Session
// → forkChat（storyDirect）→ seedNativeStory 按存档前缀建立原生上下文。只替换宿主的会话服务表与模型输出。
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Session } from './dsh-session-host.mjs'
import { createPluginHost } from './plugin-host.mjs'
import { appendSessionEvent, sessionEvents } from '../../tavern-plugin/lib/domain/session-events.js'
import { planRegenerationSurface, regenerationProjection, applyRegenerationProjection, clearFailedTurnSurface, reshadowRolledBackRounds } from '../../tavern-plugin/lib/domain/rollback-surface.js'
import { createStoryTimeline } from '../../tavern-plugin/lib/domain/story-timeline.js'
import { createFloorResultSwitch } from '../../tavern-plugin/lib/story/floor-result-switch.js'
import { projectReplyLayers } from '../../tavern-plugin/lib/domain/reply-presentation.js'
import { foldStoryRounds } from '../../tavern-plugin/lib/story/story-rounds.js'
import { forkTurnsByMessageId } from '../../tavern-plugin/lib/domain/conversation-fork-targets.js'
import { buildGameSave, readGameSave } from '../../tavern-plugin/lib/domain/game-save.js'
import { BODY_RENDER_VERSION } from '../../tavern-plugin/lib/domain/body-renderer.js'
import { nativeOpeningMessageId } from '../../tavern-plugin/lib/domain/native-opening.js'

const MODEL = { kind: 'model', provider: 'test', model: 'test' }
const reply = (id, turn, text, source = MODEL) => ({ turn, step: 1, message: { id, role: 'assistant', content: [{ type: 'text', text }], source } })
const textOf = message => (message.content || []).filter(part => part.type === 'text').map(part => part.text).join('')
const passed = name => console.log('ok ' + name)

// ---------- 源局：真实 Session + 与线上相同的存档版本与 checkpoint ----------
function createGame(name) {
  const session = Session.create(name)
  const chat = createStoryTimeline().apply({ chat: { id: name, sessionId: name, mode: 'story', cardPath: 'cards/hero.json', cardName: 'Hero',
    settleStatus: 'done', messages: [], variables: {}, regeneratedDshTurns: {} }, intent: { kind: 'ensure' } }).chat
  const revisions = []
  let revision = 0
  const g = { session, chat, revisions }
  // 存档的一个历史版本：分叉回到旧楼层时读的就是它。
  g.save = () => { revision++; g.chat._storageRevision = revision; revisions.push({ revision, state: structuredClone(g.chat) }); return revision }
  const floor = (turn, text, gold, extra = {}) => ({ role: 'assistant', turn, text, sourceText: text, projectionText: text, displayText: text,
    swipeId: 0, swipes: [text], variables: [{ 金币: gold }], ...extra })
  g.opening = (text, gold) => {
    appendSessionEvent(session, 'turn/start', { turn: 1 })
    appendSessionEvent(session, 'step/start', { turn: 1, step: 1 })
    appendSessionEvent(session, 'assistant/message', reply('opening', 1, text, { kind: 'model', provider: 'dsh-tavern', model: 'character-card' }), { surfaceOp: 'append' })
    appendSessionEvent(session, 'step/end', { turn: 1, step: 1 })
    appendSessionEvent(session, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    g.chat.messages.push(floor(1, text, gold, { greeting: true }))
    g.chat.variables = { 金币: gold }
  }
  // 一轮玩家回合：开始前存档一版并记 checkpoint（与 body.begin/commit 相同），结束后写入正文与变量。
  g.play = (turn, input, text, gold) => {
    g.chat.timeline.checkpoints.push({ id: 'cp-' + turn, turn, userText: input, beforeRevision: g.save(), committedAt: turn })
    appendSessionEvent(session, 'turn/start', { turn })
    appendSessionEvent(session, 'user/message', { id: 'in-' + turn, role: 'user', content: [{ type: 'text', text: input }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    appendSessionEvent(session, 'step/start', { turn, step: 1 })
    const seq = appendSessionEvent(session, 'assistant/message', reply('reply-' + turn, turn, text), { surfaceOp: 'append' }).seq
    appendSessionEvent(session, 'step/end', { turn, step: 1 })
    appendSessionEvent(session, 'turn/end', { turn, reason: { kind: 'completed' } })
    g.chat.messages.push({ role: 'user', text: input }, floor(turn, text, gold))
    g.chat.variables = { 金币: gold }
    if (!sessionEvents(session).some(event => event.type === 'session/title')) {
      appendSessionEvent(session, 'session/title', { title: text, messageSeqs: [], source: { kind: 'provider', provider: 'session-title-first-prompt-llm' } })
    }
    g.background()
    return seq
  }
  // 重新生成落定：尝试轮 + 投影编辑轮（rollback-surface 同一套），存档正文与变量换成新结果。
  g.regenerate = (story, attempt, text, gold, partial = false) => {
    g.chat.timeline.checkpoints.push({ id: 'cp-' + attempt, turn: attempt, userText: '', beforeRevision: g.save(), committedAt: attempt })
    const events = sessionEvents(session)
    const old = session.surface.nodes.map(seq => events[seq]).findLast(event => event.type === 'assistant/message' && (event.data.message.source.tavernStoryTurn ?? event.data.turn) === story)
    const eventStart = events.length
    appendSessionEvent(session, 'turn/start', { turn: attempt })
    appendSessionEvent(session, 'user/message', { id: 'regen-' + attempt, role: 'user', content: [{ type: 'text', text: '重生成' }], source: { kind: 'plugin:dsh-tavern-regen' } }, { surfaceOp: 'append' })
    appendSessionEvent(session, 'step/start', { turn: attempt, step: 1 })
    const seq = partial
      ? appendSessionEvent(session, 'assistant/attempt', { turn: attempt, step: 1, stream: [{ type: 'text-chunks', index: 0, texts: [text], dt: [1] }] }).seq
      : appendSessionEvent(session, 'assistant/message', reply('attempt-' + attempt, attempt, text), { surfaceOp: 'append' }).seq
    appendSessionEvent(session, 'step/end', { turn: attempt, step: 1 })
    appendSessionEvent(session, 'turn/end', { turn: attempt, reason: { kind: partial ? 'interrupted' : 'completed' } })
    const plan = planRegenerationSurface({ events: sessionEvents(session), nodes: session.surface.nodes, oldAssistantSeq: old.seq, eventStart, partial })
    applyRegenerationProjection(session, regenerationProjection(plan, reply('tavern-regen:' + attempt, story, text, { ...MODEL, tavernStoryTurn: story, ...(partial ? { tavernResultOrigin: true, tavernResultTurn: attempt, tavernIncomplete: true, tavernIncompleteReason: '已保留部分正文' } : {}) }), 'op-' + attempt))
    Object.assign(g.chat.messages.at(-1), floor(story, text, gold, { ...(g.chat.messages.at(-1).greeting ? { greeting: true } : {}), incomplete: partial, incompleteReason: partial ? '已保留部分正文' : '' }))
    g.chat.regeneratedDshTurns = { ...g.chat.regeneratedDshTurns, [story]: attempt }
    // 落定后的结算会登记一个后台 Agent（真实宿主在编辑轮之间写 subagent/catalog）。
    g.background()
    g.chat.variables = { 金币: gold }
    return seq
  }
  let backgrounds = 0
  g.background = () => appendSessionEvent(session, 'subagent/catalog', { version: 0, childId: 'background-' + name + '-' + ++backgrounds,
    childCreatedAt: backgrounds, mode: 'continuable', label: '酒馆后台 Agent' })
  // 切换历史结果：真实 C8（存档 body.edit + 原生 replace 编辑轮）。
  g.switchTo = async (story, replySeq) => {
    const agent = { session, phase: { kind: 'idle' } }
    let chat = g.chat
    const switcher = createFloorResultSwitch({
      chats: { forSession: async () => structuredClone(chat), update: async (_id, mutate) => (chat = mutate(structuredClone(chat))) },
      sessions: { get: () => agent, flush: async () => {} }, timeline: createStoryTimeline(), activity: () => ({ busy: false }),
      project: async text => projectReplyLayers(text), present: async saved => saved
    })
    const result = await switcher.switchResult({ sessionId: session.id, turn: story, replySeq })
    assert.equal(result.switched, true)
    g.chat = chat
  }
  // 失败或被打断的玩家回合：存档不写；故事视图模式下再打 C2 墓碑。
  g.fail = (turn, input, partial, reason, { tombstone }) => {
    appendSessionEvent(session, 'turn/start', { turn })
    appendSessionEvent(session, 'user/message', { id: 'in-' + turn, role: 'user', content: [{ type: 'text', text: input }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    appendSessionEvent(session, 'step/start', { turn, step: 1 })
    if (partial) appendSessionEvent(session, 'assistant/message', reply('partial-' + turn, turn, partial), { surfaceOp: 'append' })
    appendSessionEvent(session, 'step/end', { turn, step: 1 })
    appendSessionEvent(session, 'turn/end', { turn, reason: { kind: reason } })
    if (tombstone) assert.ok(clearFailedTurnSurface({ session, turn }) > 0)
  }
  // 撤回最新一层：存档回到上一 checkpoint 的版本，原生按回退方式遮住该轮。
  g.rollbackLatest = turn => {
    const checkpoint = g.chat.timeline.checkpoints.at(-1)
    assert.equal(checkpoint.turn, turn)
    const before = structuredClone(revisions.find(item => item.revision === checkpoint.beforeRevision).state)
    assert.deepEqual(reshadowRolledBackRounds(session, new Set([turn])), [turn])
    g.chat = { ...before, timeline: { ...g.chat.timeline, checkpoints: g.chat.timeline.checkpoints.slice(0, -1) }, suppressedDshTurns: [turn] }
  }
  return g
}

// ---------- 宿主会话服务：真实 Session；分叉目标是宿主新开的空白 Session ----------
const host = await createPluginHost({ withTools: true })
const sessions = host.services.get('sessions'), agents = host.services.get('agents')
sessions.flush = async () => {}
const register = (id, session) => { sessions.set(id, session); agents.set(id, { session, phase: { kind: 'idle' } }) }
agents.create = async ({ sessionId, seed, inheritedEventCount, meta }) => {
  const session = Session.create(sessionId, seed, { ...Session.create('template').header, id: sessionId, isSeeded: meta?.isSeeded === true, ...(meta?.cwd ? { cwd: meta.cwd } : {}) }, inheritedEventCount)
  register(sessionId, session)
  return { agent: agents.get(sessionId), dispose: async () => {} }
}
host.services.set('sessionPersistence', {
  open: async id => ({ header: sessions.get(id).header, inheritedEventCount: sessions.get(id).inheritedEventCount,
    read: async () => ({ events: sessionEvents(sessions.get(id)) }), close: async () => {} })
})
let forks = 0
// 侧栏 forkConversation 的 storyDirect 分支：宿主 connectWorkspace 给出一个全新的空白 Session。
const blankSession = (id = 'session-fork-' + ++forks) => { register(id, Session.create(id)); return id }
const dataRoot = process.env.DSH_HOME + '/profile-data/tavern/data'
async function importGame(g) {
  const data = buildGameSave({ chat: g.chat, revisions: g.revisions, tavernVersion: '3.1.0',
    session: { header: g.session.header, inheritedEventCount: 0, events: sessionEvents(g.session) },
    card: { payload: { kind: 'text', name: 'hero.json', text: '{"name":"Hero"}' } } })
  return await host.rpc('importGameSave', { fileB64: data.toString('base64') })
}
// 独立 UI 的 floor.target：逻辑消息的 messageUid / absoluteIndex 与读取 revision（src/client/story/transcript.js）。
async function floorTarget(sessionId, turn) {
  const { storyTranscript } = await host.rpc('getStoryTranscript', { sessionId, historyFrom: 0 })
  const row = storyTranscript.messages.find(item => item.message.role === 'assistant' && Number(item.legacyTurn) === turn)
  return row ? { messageUid: row.messageUid, messageIndex: row.absoluteIndex, revision: storyTranscript.revision } : null
}
const prepare = args => host.rpc('prepareConversationFork', args)
// tavernStory.forkAt → tavernConversationForkRequests → 侧栏 forkConversation（direct 模式）的两次 RPC。
async function forkAt(sessionId, turn, targetSessionId = blankSession()) {
  const target = await floorTarget(sessionId, turn)
  assert.ok(target, '第 ' + turn + ' 轮不在当前已加载的楼层')
  const plan = await prepare({ sessionId, messageIndex: target.messageIndex, revision: target.revision, messageUid: target.messageUid })
  assert.equal(plan.storyDirect, true)
  assert.equal(plan.atSeq, null)
  assert.equal(plan.turn, turn)
  assert.equal(plan.messageIndex, target.messageIndex)
  assert.equal(plan.messageUid, target.messageUid)
  const result = await host.rpc('forkChat', { sessionId, targetSessionId, turn: plan.turn, sourceRevision: plan.sourceRevision, atSeq: plan.atSeq,
    messageIndex: plan.messageIndex, messageUid: plan.messageUid })
  assert.equal(result.fork.sessionId, targetSessionId)
  assert.equal(result.fork.lastTurn, turn)
  assert.equal(result.fork.messageCount, target.messageIndex + 1)
  return { ...result, plan, target, session: sessions.get(targetSessionId) }
}
const exported = async sessionId => readGameSave(Buffer.from((await host.rpc('exportGameSave', { sessionId })).base64, 'base64'))
// 存档、历史版本与原生记录；导出时间戳除外。
const saveState = async sessionId => { const save = await exported(sessionId); return JSON.stringify({ chat: save.chat, revisions: save.revisions, session: save.session }) }
const floorsOf = session => foldStoryRounds(sessionEvents(session)).floors
const modelText = session => session.deriveMessages().map(textOf).join('\n')
const transcriptRows = async sessionId => (await host.rpc('getStoryTranscript', { sessionId, historyFrom: 0 })).storyTranscript.messages
  .map(item => [item.message.role, item.message.text])
const alignment = async fork => (await host.rpc('storyAlignment', { sessionId: fork.fork.sessionId })).alignment
// 存档与模型上下文真实一致：轮次对齐、锚点都在、正文无漂移、不再待同步。
async function assertAligned(fork) {
  const report = await alignment(fork)
  const detail = '第 ' + fork.plan.turn + ' 层分叉核对：' + JSON.stringify(report)
  assert.equal(report.aligned, true, detail)
  assert.equal(report.state, 'ok', detail)
  assert.equal(report.textDrift, false, detail)
  assert.deepEqual(report.anchors.lost, [], detail)
  assert.equal(report.nativeSync, '', detail)
  return report
}
async function snapshotFiles(chatId) {
  const dir = join(dataRoot, 'floor-snapshots', chatId)
  const names = (await readdir(dir).catch(() => [])).sort()
  return Promise.all(names.map(async name => name + ':' + await readFile(join(dir, name), 'utf8')))
}
const saveSnapshot = (sessionId, turn, reply, html) => host.rpc('saveFloorSnapshot', { sessionId, turn, reply, html, rendererVersion: BODY_RENDER_VERSION })
const readSnapshots = async sessionId => (await host.rpc('getFloorSnapshots', { sessionId })).snapshots

try {
  // ===== 局 A：开场 → 2 → 3（重生成两次后切回「重写一」）→ 9 → 第 10 轮被打断（墓碑）=====
  const a = createGame('game-a')
  a.opening('开场白', 0)
  a.play(2, '进门', '第二轮正文', 10)
  a.play(3, '继续', '第三轮正文', 20)
  const first3 = a.regenerate(3, 4, '重写一', 21)
  a.regenerate(3, 6, '重写二', 22)
  await a.switchTo(3, first3)
  a.play(9, '往北走', '第九轮正文', 30)
  a.fail(10, '打断的输入', '半截正文', 'aborted', { tombstone: true })
  a.save()
  const A = await importGame(a)
  const sourceA = sessions.get(A.sessionId)
  const floorsA = floorsOf(sourceA)
  assert.deepEqual(floorsA.map(floor => floor.story), [1, 2, 3, 9])
  assert.equal(floorsA[2].reply.text, '重写一')
  const rowsA = await transcriptRows(A.sessionId)
  assert.deepEqual(rowsA.map(row => row[1]), ['开场白', '进门', '第二轮正文', '继续', '重写一', '往北走', '第九轮正文'])
  // 源局各层的快照（C3），来源是当前 reply seq；服务端只接受当前正文渲染版本。
  for (const floor of floorsA) await saveSnapshot(A.sessionId, floor.story, String(floor.reply.seq), '<p>快照' + floor.story + '</p>')
  // 导入后的模板渲染等后台写入先落定，之后的任何变化才归分叉。
  let settledSave = await saveState(A.sessionId)
  for (let tries = 0, quiet = 0; quiet < 6; tries++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const next = await saveState(A.sessionId)
    quiet = next === settledSave ? quiet + 1 : 0
    assert.ok(tries < 40, '源局存档迟迟不稳定')
    settledSave = next
  }
  const before = { events: JSON.stringify(sessionEvents(sourceA)), save: settledSave, snapshots: await snapshotFiles(A.chatId) }

  // (1)(2)(3) 非最新楼层，重生成两次又切换过：带走当前选中的「重写一」，不带后续楼层、输入与变量。
  const at3 = await forkAt(A.sessionId, 3)
  assert.notEqual(at3.fork.chatId, A.chatId)
  assert.deepEqual(await transcriptRows(at3.fork.sessionId), rowsA.slice(0, 5), '分叉存档是源局逻辑消息的精确前缀')
  const fork3 = await exported(at3.fork.sessionId)
  const last3 = fork3.chat.messages.at(-1)
  assert.equal(last3.turn, 3)
  assert.equal(last3.sourceText, '重写一')
  assert.equal(fork3.chat.messages.length, 5)
  assert.equal(last3.messageUid, at3.target.messageUid, '分叉保留所选消息的永久身份')
  assert.deepEqual(last3.variables, [{ 金币: 22 }], '切换不重放 MVU：分叉沿用切换时该层的变量')
  assert.deepEqual(fork3.chat.variables, { 金币: 22 })
  assert.deepEqual({ ...fork3.chat.forkedFrom, forkedAt: 0 }, { ...fork3.chat.forkedFrom, forkedAt: 0, chatId: A.chatId, sessionId: A.sessionId, turn: 3, messageIndex: 4, atSeq: null })
  assert.equal(fork3.chat.nativeSync, undefined, '原生上下文已按存档建立，不再标记待同步')
  assert.equal(fork3.chat.nativeOpeningAppended, true)
  // 新局的模型上下文只按分叉存档前缀建立：选中版本在，其它版本与后续楼层不在。
  assert.deepEqual(floorsOf(at3.session).map(floor => [floor.story, floor.reply.text]), [[1, '开场白'], [2, '第二轮正文'], [3, '重写一']])
  const model3 = modelText(at3.session)
  assert.match(model3, /开场白[\s\S]*进门[\s\S]*第二轮正文[\s\S]*继续[\s\S]*重写一/)
  for (const absent of ['重写二', '第三轮正文', '往北走', '第九轮正文', '打断的输入', '半截正文']) assert.doesNotMatch(model3, new RegExp(absent))
  passed('1 切换结果后分叉带走选中版本')
  passed('3 非最新楼层不带后续楼层、输入与 MVU 变化')
  // 新局再折叠（C1）：楼层只有选中的那份结果；继续下一轮时模型上下文里是选中版本。
  const folded3 = floorsOf(at3.session)
  assert.deepEqual(folded3.at(-1).history.map(item => [item.text, item.current]), [['重写一', true]], '新局原生上下文只含选中版本，未选中的生成不带过去')
  assert.equal(folded3.at(-1).reply.text, '重写一')
  const nextTurn = Math.max(...sessionEvents(at3.session).filter(event => event.type === 'turn/start').map(event => event.data.turn)) + 1
  appendSessionEvent(at3.session, 'turn/start', { turn: nextTurn })
  appendSessionEvent(at3.session, 'user/message', { id: 'branch-in', role: 'user', content: [{ type: 'text', text: '分支里的新输入' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  const request = at3.session.deriveMessages().map(textOf).filter(Boolean)
  assert.equal(request.at(-1), '分支里的新输入')
  assert.equal(request.at(-2), '重写一')
  assert.deepEqual(request.filter(text => /第二轮正文|重写|第三轮|开场白/.test(text)), ['开场白', '第二轮正文', '重写一'])
  passed('C1 新局折叠与下一轮请求是选中版本')

  // (9) 快照按存档身份隔离：新局不读源局快照，可按当前渲染版本写读自己的，源局快照目录不变。
  assert.deepEqual(await readSnapshots(at3.fork.sessionId), {}, '新局快照不串用源局（楼号相同也不复制）')
  const forkReply = String(folded3.at(-1).reply.seq)
  assert.equal((await saveSnapshot(at3.fork.sessionId, 3, forkReply, '<p>新局快照3</p>')).saved, true)
  await assert.rejects(host.rpc('saveFloorSnapshot', { sessionId: at3.fork.sessionId, turn: 3, reply: forkReply, html: '<p>旧版本</p>', rendererVersion: BODY_RENDER_VERSION - 1 }), /正文渲染版本已更新/)
  const snaps3 = await readSnapshots(at3.fork.sessionId)
  assert.deepEqual(Object.keys(snaps3).map(Number), [3])
  assert.equal(snaps3[3].html, '<p>新局快照3</p>')
  assert.equal(snaps3[3].reply, forkReply)
  assert.equal(snaps3[3].rendererVersion, BODY_RENDER_VERSION)
  assert.deepEqual(await snapshotFiles(A.chatId), before.snapshots)
  passed('9 新局快照身份独立且可写读当前版本')

  // (4) 最新楼层后紧跟打断墓碑：不拒绝，墓碑与被打断的输入不带过去。
  const at9 = await forkAt(A.sessionId, 9)
  assert.deepEqual(floorsOf(at9.session).map(floor => floor.story), [1, 2, 3, 9])
  const model9 = modelText(at9.session)
  assert.match(model9, /第九轮正文/)
  assert.doesNotMatch(model9, /打断的输入|半截正文|重写二|第三轮正文/)
  assert.ok(!sessionEvents(at9.session).some(event => event.data?.source?.kind === 'plugin:dsh-tavern-failed-turn-cleanup'))
  const fork9 = await exported(at9.fork.sessionId)
  assert.equal(fork9.chat.messages.at(-1).sourceText, '第九轮正文')
  assert.deepEqual(fork9.chat.variables, { 金币: 30 })
  assert.deepEqual(await readSnapshots(at9.fork.sessionId), {})
  // (6) 开场楼层。
  const at1 = await forkAt(A.sessionId, 1)
  assert.deepEqual(floorsOf(at1.session).map(floor => floor.story), [1])
  const fork1 = await exported(at1.fork.sessionId)
  assert.equal(fork1.chat.messages.length, 1)
  assert.equal(fork1.chat.messages[0].greeting, true)
  assert.deepEqual(fork1.chat.variables, { 金币: 0 })
  assert.doesNotMatch(modelText(at1.session), /进门|第二轮正文/)
  assert.ok(sessionEvents(at1.session).some(event => event.data?.message?.id === nativeOpeningMessageId(fork1.chat.id)), '新局开场白以新局身份写入原生上下文')
  // 存档与模型上下文核对：三个分叉都按新局身份完全对齐（同一编辑轮写入的多层正文各按自己的故事身份定位）。
  for (const fork of [at1, at3, at9]) await assertAligned(fork)
  passed('6 开场楼层可分叉')
  // 中间楼层 2：不带第 3 层的任何版本。
  const at2 = await forkAt(A.sessionId, 2)
  assert.doesNotMatch(modelText(at2.session), /重写|第三轮/)
  assert.deepEqual((await exported(at2.fork.sessionId)).chat.variables, { 金币: 10 })

  // (8) 原会话零改动：事件、存档（含历史版本）与快照目录。
  assert.equal(JSON.stringify(sessionEvents(sourceA)), before.events)
  assert.equal(await saveState(A.sessionId), before.save)
  assert.deepEqual(await snapshotFiles(A.chatId), before.snapshots)
  passed('8 原会话零改动')

  // (5) 运行中拒绝，且不留目标会话以外的任何写入。
  const target3 = await floorTarget(A.sessionId, 3)
  const planArgs = { sessionId: A.sessionId, messageIndex: target3.messageIndex, revision: target3.revision, messageUid: target3.messageUid }
  agents.get(A.sessionId).phase.kind = 'running'
  await assert.rejects(prepare(planArgs), /正在生成|仍在生成/)
  agents.get(A.sessionId).phase.kind = 'idle'
  const plan = await prepare(planArgs)
  const stray = blankSession()
  const bindArgs = { sessionId: A.sessionId, targetSessionId: stray, turn: plan.turn, sourceRevision: plan.sourceRevision, atSeq: plan.atSeq, messageIndex: plan.messageIndex, messageUid: plan.messageUid }
  agents.get(A.sessionId).phase.kind = 'running'
  await assert.rejects(host.rpc('forkChat', bindArgs), /仍在生成/)
  agents.get(A.sessionId).phase.kind = 'idle'
  assert.equal(await host.rpc('listSessions').then(result => result.sessions.some(chat => chat.sessionId === stray)), false, '被拒的目标 Session 没有绑定存档')
  passed('5a 运行中拒绝')
  // 失效身份、revision 冲突、非正文消息与目标会话校验：都在绑定前拒绝，源局不变。
  await assert.rejects(prepare({ ...planArgs, messageUid: 'missing-uid' }), /分叉消息已经变化/)
  await assert.rejects(prepare({ sessionId: A.sessionId, messageIndex: target3.messageIndex, revision: target3.revision - 1 }), /剧情已变化/)
  await assert.rejects(prepare({ sessionId: A.sessionId, messageIndex: target3.messageIndex, revision: target3.revision, messageUid: '' }), /分叉消息身份无效/)
  await assert.rejects(prepare({ sessionId: A.sessionId, messageIndex: -1, revision: target3.revision }), /分叉消息位置无效/)
  await assert.rejects(prepare({ sessionId: A.sessionId, messageIndex: 99, revision: target3.revision }), /找不到指定分叉消息/)
  await assert.rejects(prepare({ sessionId: A.sessionId, messageIndex: target3.messageIndex - 1, revision: target3.revision }), /分叉点必须是正文消息/)
  assert.equal(await floorTarget(A.sessionId, 10), null, '被打断的第 10 轮不是楼层，界面不会发请求')
  // 目标必须是尚未绑定存档的空白 Session：已有存档的会话、带历史的会话都拒绝。
  await assert.rejects(host.rpc('forkChat', { ...bindArgs, targetSessionId: A.sessionId }), /尚未绑定对话的新 Session/)
  const used = Session.create('session-with-history')
  appendSessionEvent(used, 'turn/start', { turn: 1 })
  appendSessionEvent(used, 'user/message', { id: 'used-in', role: 'user', content: [{ type: 'text', text: '别的输入' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  appendSessionEvent(used, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  register(used.id, used)
  const usedBefore = JSON.stringify(sessionEvents(used))
  await assert.rejects(host.rpc('forkChat', { ...bindArgs, targetSessionId: used.id }), /分叉目标必须是空白 Session/)
  assert.equal(JSON.stringify(sessionEvents(used)), usedBefore)
  assert.equal(await host.rpc('listSessions').then(result => result.sessions.some(chat => chat.sessionId === used.id)), false)
  // 已绑定过一次的目标不能再绑第二份存档。
  const bound = await forkAt(A.sessionId, 2, stray)
  await assert.rejects(host.rpc('forkChat', { ...bindArgs, targetSessionId: stray }), /尚未绑定对话的新 Session/)
  assert.equal((await exported(bound.fork.sessionId)).chat.messages.length, 3)
  assert.equal(JSON.stringify(sessionEvents(sourceA)), before.events)
  assert.equal(await saveState(A.sessionId), before.save)
  passed('5d 冲突、失效身份与目标校验拒绝')

  // ===== 局 B：最新楼层重生成两次后切回原结果 =====
  const b = createGame('game-b')
  b.opening('B开场', 0)
  const originalB = b.play(2, '出发', 'B原始正文', 5)
  b.regenerate(2, 3, 'B新一', 6)
  b.regenerate(2, 5, 'B新二', 7)
  await b.switchTo(2, originalB)
  b.save()
  const B = await importGame(b)
  const atB = await forkAt(B.sessionId, 2)
  const forkB = await exported(atB.fork.sessionId)
  assert.equal(forkB.chat.messages.at(-1).sourceText, 'B原始正文')
  assert.match(modelText(atB.session), /B原始正文/)
  assert.doesNotMatch(modelText(atB.session), /B新一|B新二/)
  assert.deepEqual(floorsOf(atB.session).at(-1).history.map(item => [item.text, item.current]), [['B原始正文', true]])
  // (10) forkTurnsByMessageId：切换写入的替换节点也映射回故事轮 2（新流程不依赖它）。
  const switchNode = sessionEvents(sessions.get(B.sessionId)).findLast(event => event.data?.message?.source?.model === 'result-switch')
  assert.equal(forkTurnsByMessageId(sessions.get(B.sessionId), b.chat.regeneratedDshTurns)[switchNode.data.message.id], 2)
  await assertAligned(atB)
  passed('1b 最新楼层切换结果后分叉')
  passed('10 forkTurnsByMessageId 切换后仍指向故事轮')

  // ===== 局 C：最新楼层重生成落定（未切换）=====
  const c = createGame('game-c')
  c.opening('C开场', 0)
  c.play(2, '走', 'C旧正文', 1)
  c.regenerate(2, 3, 'C落定正文', 2)
  c.save()
  const C = await importGame(c)
  const atC = await forkAt(C.sessionId, 2)
  assert.equal((await exported(atC.fork.sessionId)).chat.messages.at(-1).sourceText, 'C落定正文')
  assert.match(modelText(atC.session), /C落定正文/)
  assert.doesNotMatch(modelText(atC.session), /C旧正文/)
  await assertAligned(atC)
  // 重生成尝试进行中（尝试轮已开始、前台在跑）：拒绝。
  const targetC = await floorTarget(C.sessionId, 2)
  appendSessionEvent(sessions.get(C.sessionId), 'turn/start', { turn: 5 })
  appendSessionEvent(sessions.get(C.sessionId), 'user/message', { id: 'regen-5', role: 'user', content: [{ type: 'text', text: '重生成' }], source: { kind: 'plugin:dsh-tavern-regen' } }, { surfaceOp: 'append' })
  assert.equal(foldStoryRounds(sessionEvents(sessions.get(C.sessionId))).attempt?.regenerating, true)
  agents.get(C.sessionId).phase.kind = 'running'
  await assert.rejects(prepare({ sessionId: C.sessionId, ...targetC }), /仍在生成/)
  passed('2 重生成落定后分叉带走落定版本')
  passed('5b 重生成尝试中拒绝')

  // ===== 局 D：撤回第 3 层、第 4 轮失败（无墓碑）=====
  const d = createGame('game-d')
  d.opening('D开场', 0)
  d.play(2, '一', 'D第二轮', 1)
  d.play(3, '被撤回的输入', 'D第三轮', 2)
  d.rollbackLatest(3)
  d.fail(4, 'D失败的输入', '', 'error', { tombstone: false })
  d.save()
  const D = await importGame(d)
  assert.equal(await floorTarget(D.sessionId, 3), null, '已撤回的第 3 层不再是楼层')
  const atD = await forkAt(D.sessionId, 2)
  assert.deepEqual(floorsOf(atD.session).map(floor => floor.story), [1, 2])
  assert.doesNotMatch(modelText(atD.session), /D第三轮|D失败的输入|被撤回的输入/)
  const forkD = await exported(atD.fork.sessionId)
  assert.equal(forkD.chat.messages.at(-1).sourceText, 'D第二轮')
  assert.deepEqual(forkD.chat.suppressedDshTurns ?? [], [], '源局的撤回记录不带进新局')
  await assertAligned(atD)
  passed('4 撤回、打断与失败尾部不带过去也不拒绝')

  // ===== 局 E：后台结算中 =====
  const e = createGame('game-e')
  e.opening('E开场', 0)
  e.play(2, '一', 'E第二轮', 1)
  e.chat.settleStatus = 'running'
  e.save()
  const E = await importGame(e)
  await assert.rejects(prepare({ sessionId: E.sessionId, ...await floorTarget(E.sessionId, 2) }), /状态结算/)
  await assert.rejects(prepare({ sessionId: E.sessionId, ...await floorTarget(E.sessionId, 1) }), /状态结算/)
  passed('5c 后台结算中拒绝')

  // ===== 局 F：官方 MVU 卡，最新楼层切回原结果（真实 C8；本夹具宿主未装会话补丁，切换 RPC 被拒，同 1b
  // 在导入前切换）：存档标记变量未重算，getSession 视图给出 staleVariables，分叉新局带着 =====
  const f = createGame('game-f')
  f.chat.mvu = { enabled: true, owner: 'official' }
  f.opening('F开场', 0)
  const originalF = f.play(2, '领奖', 'F原始正文', 10)
  f.regenerate(2, 3, 'F改写正文', 30)
  await f.switchTo(2, originalF)
  assert.deepEqual(f.chat.messages.at(-1).variablesStale, { replySeq: originalF })
  f.save()
  const F = await importGame(f)
  const staleOf = async sessionId => (await host.rpc('getSession', { sessionId })).view.staleVariables
  assert.deepEqual(await staleOf(F.sessionId), { turn: 2, replySeq: originalF })
  assert.deepEqual((await exported(F.sessionId)).chat.messages.at(-1).variablesStale, { replySeq: originalF })
  const atF = await forkAt(F.sessionId, 2)
  assert.deepEqual((await exported(atF.fork.sessionId)).chat.messages.at(-1).variablesStale, { replySeq: originalF })
  assert.deepEqual(await staleOf(atF.fork.sessionId), { turn: 2, replySeq: originalF })
  // 非 MVU 局切换后（局 B）视图没有标记。
  assert.equal(await staleOf(B.sessionId), null)
  passed('11 MVU 变量未重算标记随存档与分叉保留')
  // 删除真实分支入口同时回收快照目录；旧快照服务实例冷读也不能重新显示它；源局快照保持。
  const deletedSave = await exported(at1.fork.sessionId)
  assert.equal((await saveSnapshot(at1.fork.sessionId, 1, String(floorsOf(at1.session)[0].reply.seq), '<p>分支开场快照</p>')).saved, true)
  assert.ok((await snapshotFiles(deletedSave.chat.id)).length > 0)
  await host.rpc('deleteChat', { chatId: deletedSave.chat.id })
  assert.deepEqual(await snapshotFiles(deletedSave.chat.id), [])
  const { createFloorSnapshots } = await import('../../tavern-plugin/lib/story/floor-snapshots.js')
  const { createProfileDataStore } = await import('../../tavern-plugin/lib/profile-data-store.js')
  const coldSnapshots = createFloorSnapshots({ store: createProfileDataStore({ dataRoot }), chatIdFor: async () => deletedSave.chat.id })
  assert.deepEqual(await coldSnapshots.read({ sessionId: at1.fork.sessionId }), { snapshots: {} })
  await assert.rejects(host.rpc('getFloorSnapshots', { sessionId: at1.fork.sessionId }), /找不到当前存档/)
  assert.deepEqual(await snapshotFiles(A.chatId), before.snapshots, '删除分支不能动源局快照')
  assert.deepEqual(Object.keys(await readSnapshots(at3.fork.sessionId)).map(Number), [3], '删除分支不能动其它分支的快照')
  passed('12 删除分支回收快照且源局不变')
  // 部分正文没有 assistant/message：接纳后仍是独立结果，切换与分叉携带状态及变量边界。
  const partialGame = createGame('game-partial')
  partialGame.chat.mvu = { enabled: true, owner: 'official' }
  partialGame.opening('P开场', 0)
  const originalPartial = partialGame.play(2, '前进', 'P完整正文', 10)
  partialGame.regenerate(2, 3, 'P部分正文', 12, true)
  const partialFloor = floorsOf(partialGame.session).at(-1)
  const partialSeq = partialFloor.history.find(item => item.current).seq
  assert.deepEqual(partialFloor.history.map(item => [item.text, Boolean(item.incomplete)]), [['P完整正文', false], ['P部分正文', true]])
  await partialGame.switchTo(2, originalPartial)
  assert.equal(floorsOf(partialGame.session).at(-1).reply.incomplete, undefined)
  assert.equal(partialGame.chat.messages.at(-1).incomplete, false)
  await partialGame.switchTo(2, partialSeq)
  assert.equal(partialGame.chat.messages.at(-1).incomplete, true)
  assert.deepEqual(partialGame.chat.messages.at(-1).variablesStale, { replySeq: partialSeq })
  partialGame.save()
  const importedPartial = await importGame(partialGame)
  // 已接纳的部分正文是最新楼层：按现行范围允许分叉，不完整标记与变量边界随存档带走。
  const branchPartial = await forkAt(importedPartial.sessionId, 2)
  const partialSave = (await exported(branchPartial.fork.sessionId)).chat
  assert.equal(partialSave.messages.at(-1).incomplete, true)
  assert.deepEqual(partialSave.messages.at(-1).variablesStale, { replySeq: partialSeq })
  assert.match(modelText(branchPartial.session), /P部分正文/)
  assert.doesNotMatch(modelText(branchPartial.session), /P完整正文/)
  passed('13 部分正文结果切换与分叉保留不完整状态及变量边界')
  // 压缩的原生替换与导出冷读：保留早期分叉，源局模型仍只看摘要。
  const compactGame = createGame('game-compacted')
  compactGame.opening('压缩前开场', 0)
  for (let turn = 2; turn <= 45; turn++) compactGame.play(turn, '压缩输入' + turn, '压缩正文' + turn, turn)
  compactGame.save()
  const expected = floorsOf(compactGame.session)
  const nodes = [...compactGame.session.surface.nodes]
  const compactionId = 'test-compact', shadowed = nodes.slice(0, -2)
  const start = appendSessionEvent(compactGame.session, 'compaction/start', { compactionId, turn: null })
  const summary = appendSessionEvent(compactGame.session, 'compaction/summary', {
    compactionId, summary: [{ type: 'text', text: '仅供模型的压缩摘要' }],
    shadowedRange: { start: shadowed[0], end: shadowed.at(-1) }, shadowedSeqs: shadowed,
    shadowedTokenCount: 1000, provider: 'test', model: 'test'
  })
  appendSessionEvent(compactGame.session, 'user/message', {
    id: 'compact-checkpoint', role: 'user', source: { kind: 'compact-checkpoint', compactionId: 'test-compact' },
    content: [{ type: 'text', text: '仅供模型的压缩摘要' }]
  }, { surfaceOp: { op: 'replace', startSeq: nodes[0], endSeq: nodes.at(-3) }, sourceEventSeqs: [start.seq, summary.seq, ...shadowed] })
  appendSessionEvent(compactGame.session, 'compaction/end', { compactionId, turn: null })
  assert.deepEqual(floorsOf(compactGame.session), expected)
  const compacted = await importGame(compactGame)
  const sourceCompact = sessions.get(compacted.sessionId)
  const beforeCompact = JSON.stringify(sessionEvents(sourceCompact))
  const early = await forkAt(compacted.sessionId, 2)
  assert.deepEqual(floorsOf(early.session).map(floor => floor.story), [1, 2])
  assert.match(modelText(early.session), /压缩前开场[\s\S]*压缩正文2/)
  assert.doesNotMatch(modelText(early.session), /压缩正文3|仅供模型的压缩摘要/)
  assert.deepEqual((await exported(early.fork.sessionId)).chat.variables, { 金币: 2 })
  assert.equal(JSON.stringify(sessionEvents(sourceCompact)), beforeCompact)
  assert.match(modelText(sourceCompact), /仅供模型的压缩摘要/)
  assert.doesNotMatch(modelText(sourceCompact), /压缩正文2/)
  passed('14 压缩后早期楼层分叉且源局上下文不变')

  // ===== 局 G：建立原生上下文时持久化失败 → 存档仍绑定、标记 stale 且核对明确报告；开场恢复不重复开场 =====
  const g = createGame('game-seed-fail')
  g.opening('G开场', 0)
  g.play(2, '一', 'G第二轮', 1)
  g.save()
  const G = await importGame(g)
  const failing = blankSession('session-seed-fail')
  const flush = sessions.flush
  sessions.flush = async session => { if (session?.id === failing) throw new Error('模拟原生上下文持久化失败') }
  let atG
  try { atG = await forkAt(G.sessionId, 2, failing) } finally { sessions.flush = flush }
  const forkG = (await exported(failing)).chat
  assert.equal(forkG.messages.length, 3, '存档已绑定，前缀完整')
  assert.equal(forkG.nativeSync?.status, 'stale')
  assert.equal(forkG.nativeOpeningAppended, false, '原生上下文未落定，不把开场白标记为已写入')
  const alignmentG = await alignment(atG)
  assert.equal(alignmentG.nativeSync, 'stale')
  assert.equal(alignmentG.aligned, false, '核对明确报告上次同步失败，不自动修复')
  const openingsOf = session => sessionEvents(session).filter(event => event.type === 'assistant/message' && event.data?.message?.id === nativeOpeningMessageId(forkG.id)).length
  assert.equal(openingsOf(atG.session), 1)
  // 下次打开时的开场恢复入口（RPC ensureOpening → conversationInitialization.ensureOpening）。现有契约：
  // 开场白已在原生记录里但后面跟着其它轮次时，明确拒绝重复写入；没有重新建立原生上下文的入口，stale 标记保留。
  const nativeBefore = sessionEvents(atG.session).map(event => JSON.stringify(event))
  // plugin-host 的 rpc 把服务端错误文本放在断言消息首行；这里按精确文本核对，不接受其它异常。
  const recovery = await host.rpc('ensureOpening', { sessionId: failing }).then(() => 'ok', error => String(error.message).split('\n')[0])
  assert.equal(recovery, '开场白事件不完整且已被其他操作推进，拒绝重复写入')
  assert.equal(openingsOf(atG.session), 1, '开场恢复不重复开场')
  // 拒绝前只补了注入上下文（会话前缀与种子轨迹），已有原生记录与故事楼层都不变。
  const nativeAfter = sessionEvents(atG.session).map(event => JSON.stringify(event))
  assert.deepEqual(nativeAfter.slice(0, nativeBefore.length), nativeBefore)
  const added = sessionEvents(atG.session).slice(nativeBefore.length)
  assert.ok(added.length > 0 && added.every(event => /^tavern-(session-prefix|seed-trajectory):/.test(String(event.data?.message?.id ?? event.data?.id ?? ''))), JSON.stringify(added.map(event => [event.type, event.data?.message?.id ?? event.data?.id])))
  const afterG = (await exported(failing)).chat
  assert.equal(afterG.nativeSync?.status, 'stale', '已发布存档保持 stale')
  assert.equal(afterG.nativeOpeningAppended, false)
  assert.equal(afterG.messages.length, 3)
  const alignmentAfter = await alignment(atG)
  assert.equal(alignmentAfter.nativeSync, 'stale')
  assert.equal(alignmentAfter.aligned, false)
  passed('15 原生上下文建立失败后标记 stale、核对报告且不重复开场')

  // ===== 局 H：存档救援导入的历史没有状态快照，不能从这条消息分叉 =====
  const h = createGame('game-rescued')
  h.opening('H开场', 0)
  h.play(2, '迁入的输入', 'H迁入正文', 1)
  h.chat.importHistory = { operationId: 'rescue-op', rescue: { sourceChatId: 'broken-chat', sourceRevision: 3, mvuSnapshot: null }, warnings: [] }
  for (const message of h.chat.messages.slice(1)) message.importSource = { operationId: 'rescue-op' }
  h.save()
  const H = await importGame(h)
  await assert.rejects(prepare({ sessionId: H.sessionId, ...await floorTarget(H.sessionId, 2) }), /救援导入的历史没有状态快照/)
  passed('16 救援导入的消息拒绝分叉')
  console.log('story fork rpc passed')
} finally { await host.dispose() }
