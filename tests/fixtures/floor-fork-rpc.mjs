// 从楼层创建分支的真实插件 RPC 场景（tests/floor-fork.test.mjs 在独立 DSH_HOME 子进程里运行）。
// 源局用真实宿主 Session 与 Tavern 领域函数玩出（重生成、结果切换、打断墓碑、撤回、失败轮），
// 经 importGameSave 进入真实存储；分叉走 prepareFloorFork → 宿主 buildForkSeed（与
// session-controller fork 相同）→ forkFloor。只替换宿主的会话服务表与模型输出。
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Session, buildForkSeed } from './dsh-session-host.mjs'
import { createPluginHost } from './plugin-host.mjs'
import { appendSessionEvent, sessionEvents } from '../../tavern-plugin/lib/domain/session-events.js'
import { planRegenerationSurface, regenerationProjection, applyRegenerationProjection, clearFailedTurnSurface, reshadowRolledBackRounds } from '../../tavern-plugin/lib/domain/rollback-surface.js'
import { createStoryTimeline } from '../../tavern-plugin/lib/domain/story-timeline.js'
import { createFloorResultSwitch } from '../../tavern-plugin/lib/domain/floor-result-switch.js'
import { projectReplyLayers } from '../../tavern-plugin/lib/domain/reply-presentation.js'
import { foldStoryRounds } from '../../tavern-plugin/lib/domain/story-rounds.js'
import { forkTurnsByMessageId } from '../../tavern-plugin/lib/domain/conversation-fork-targets.js'
import { buildGameSave, readGameSave } from '../../tavern-plugin/lib/domain/game-save.js'

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
  g.regenerate = (story, attempt, text, gold) => {
    g.chat.timeline.checkpoints.push({ id: 'cp-' + attempt, turn: attempt, userText: '', beforeRevision: g.save(), committedAt: attempt })
    const events = sessionEvents(session)
    const old = session.surface.nodes.map(seq => events[seq]).findLast(event => event.type === 'assistant/message' && (event.data.message.source.tavernStoryTurn ?? event.data.turn) === story)
    const eventStart = events.length
    appendSessionEvent(session, 'turn/start', { turn: attempt })
    appendSessionEvent(session, 'user/message', { id: 'regen-' + attempt, role: 'user', content: [{ type: 'text', text: '重生成' }], source: { kind: 'plugin:dsh-tavern-regen' } }, { surfaceOp: 'append' })
    appendSessionEvent(session, 'step/start', { turn: attempt, step: 1 })
    const seq = appendSessionEvent(session, 'assistant/message', reply('attempt-' + attempt, attempt, text), { surfaceOp: 'append' }).seq
    appendSessionEvent(session, 'step/end', { turn: attempt, step: 1 })
    appendSessionEvent(session, 'turn/end', { turn: attempt, reason: { kind: 'completed' } })
    const plan = planRegenerationSurface({ events: sessionEvents(session), nodes: session.surface.nodes, oldAssistantSeq: old.seq, eventStart })
    applyRegenerationProjection(session, regenerationProjection(plan, reply('tavern-regen:' + attempt, story, text, { ...MODEL, tavernStoryTurn: story }), 'op-' + attempt))
    Object.assign(g.chat.messages.at(-1), floor(story, text, gold, g.chat.messages.at(-1).greeting ? { greeting: true } : {}))
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

// ---------- 宿主会话服务：真实 Session，按 session-controller 的方式分叉 ----------
const host = await createPluginHost()
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
function hostFork(sourceId, atSeq) {
  const source = sessions.get(sourceId), id = 'session-fork-' + ++forks
  register(id, Session.create(id, buildForkSeed(sessionEvents(source), atSeq), { ...source.header, id, isSeeded: true, parentSession: sourceId }, atSeq + 1))
  return id
}
const dataRoot = process.env.DSH_HOME + '/profile-data/tavern/data'
async function importGame(g) {
  const data = buildGameSave({ chat: g.chat, revisions: g.revisions, tavernVersion: '3.1.0',
    session: { header: g.session.header, inheritedEventCount: 0, events: sessionEvents(g.session) },
    card: { payload: { kind: 'text', name: 'hero.json', text: '{"name":"Hero"}' } } })
  return await host.rpc('importGameSave', { fileB64: data.toString('base64') })
}
async function forkAt(sessionId, turn) {
  const plan = await host.rpc('prepareFloorFork', { sessionId, turn })
  const targetSessionId = hostFork(sessionId, plan.atSeq)
  const result = await host.rpc('forkFloor', { sessionId, turn, targetSessionId, sourceRevision: plan.sourceRevision, atSeq: plan.atSeq })
  assert.equal(result.fork.sessionId, targetSessionId)
  assert.equal(result.turn, turn)
  assert.equal(result.replySeq, plan.replySeq)
  return { ...result, plan, session: sessions.get(targetSessionId) }
}
const exported = async sessionId => readGameSave(Buffer.from((await host.rpc('exportGameSave', { sessionId })).base64, 'base64'))
// 存档、历史版本与原生记录；导出时间戳除外。
const saveState = async sessionId => { const save = await exported(sessionId); return JSON.stringify({ chat: save.chat, revisions: save.revisions, session: save.session }) }
const floorsOf = session => foldStoryRounds(sessionEvents(session)).floors
const modelText = session => session.deriveMessages().map(textOf).join('\n')
async function snapshotFiles(chatId) {
  const dir = join(dataRoot, 'floor-snapshots', chatId)
  const names = (await readdir(dir).catch(() => [])).sort()
  return Promise.all(names.map(async name => name + ':' + await readFile(join(dir, name), 'utf8')))
}

try {
  // ===== 局 A：开场 → 2 → 3（重生成两次后切回「重写一」）→ 9 → 第 10 轮被打断（墓碑）=====
  const a = createGame('game-a')
  a.opening('开场白', 0)
  a.play(2, '进门', '第二轮正文', 10)
  const original3 = a.play(3, '继续', '第三轮正文', 20)
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
  // 源局各层的快照（C3），来源是当前 reply seq。
  for (const floor of floorsA) await host.rpc('saveFloorSnapshot', { sessionId: A.sessionId, turn: floor.story, reply: String(floor.reply.seq), html: '<p>快照' + floor.story + '</p>' })
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
  assert.equal(at3.replySeq, floorsA[2].reply.seq)
  assert.deepEqual(floorsOf(at3.session).map(floor => [floor.story, floor.reply.seq]), floorsA.slice(0, 3).map(floor => [floor.story, floor.reply.seq]))
  const fork3 = await exported(at3.fork.sessionId)
  const last3 = fork3.chat.messages.at(-1)
  assert.equal(last3.turn, 3)
  assert.equal(last3.sourceText, '重写一')
  assert.equal(fork3.chat.messages.length, 5)
  assert.deepEqual(last3.variables, [{ 金币: 22 }], '切换不重放 MVU：分叉沿用切换时该层的变量')
  assert.deepEqual(fork3.chat.variables, { 金币: 22 })
  assert.equal(fork3.chat.regeneratedDshTurns['3'], 6)
  assert.equal(fork3.chat.forkedFrom.turn, 3)
  const model3 = modelText(at3.session)
  assert.match(model3, /重写一/)
  for (const absent of ['重写二', '第三轮正文', '往北走', '第九轮正文', '打断的输入', '半截正文']) assert.doesNotMatch(model3, new RegExp(absent))
  passed('1 切换结果后分叉带走选中版本')
  passed('3 非最新楼层不带后续楼层、输入与 MVU 变化')

  // 新局再折叠（C1）：楼层与 history[].current 正确；继续下一轮时模型上下文里是选中版本。
  const folded3 = floorsOf(at3.session)
  assert.deepEqual(folded3.at(-1).history.map(item => [item.seq, item.text, item.current]),
    [[original3, '第三轮正文', false], [first3, '重写一', true], [floorsA[2].history[2].seq, '重写二', false]])
  assert.equal(folded3.at(-1).reply.text, '重写一')
  const nextTurn = Math.max(...sessionEvents(at3.session).filter(event => event.type === 'turn/start').map(event => event.data.turn)) + 1
  appendSessionEvent(at3.session, 'turn/start', { turn: nextTurn })
  appendSessionEvent(at3.session, 'user/message', { id: 'branch-in', role: 'user', content: [{ type: 'text', text: '分支里的新输入' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  const request = at3.session.deriveMessages().map(textOf).filter(Boolean)
  assert.equal(request.at(-1), '分支里的新输入')
  assert.equal(request.at(-2), '重写一')
  assert.deepEqual(request.filter(text => /第二轮正文|重写|第三轮|开场白/.test(text)), ['开场白', '第二轮正文', '重写一'])
  passed('C1 新局折叠与下一轮请求是选中版本')

  // (9) 快照只复制分叉层及之前的，来源 seq 在新局仍有效。
  const snaps3 = (await host.rpc('getFloorSnapshots', { sessionId: at3.fork.sessionId })).snapshots
  assert.deepEqual(Object.keys(snaps3).map(Number), [1, 2, 3])
  for (const floor of folded3) assert.equal(snaps3[floor.story].reply, String(floor.reply.seq))
  assert.equal(snaps3[3].html, '<p>快照3</p>')
  passed('9 快照按楼层复制')

  // (4) 最新楼层后紧跟打断墓碑：不拒绝，墓碑与被打断的输入不带过去。
  const at9 = await forkAt(A.sessionId, 9)
  assert.deepEqual(floorsOf(at9.session).map(floor => floor.story), [1, 2, 3, 9])
  const model9 = modelText(at9.session)
  assert.match(model9, /第九轮正文/)
  assert.doesNotMatch(model9, /打断的输入|半截正文/)
  assert.ok(!sessionEvents(at9.session).some(event => event.data?.source?.kind === 'plugin:dsh-tavern-failed-turn-cleanup'))
  const fork9 = await exported(at9.fork.sessionId)
  assert.equal(fork9.chat.messages.at(-1).sourceText, '第九轮正文')
  assert.deepEqual(fork9.chat.variables, { 金币: 30 })
  assert.deepEqual(Object.keys((await host.rpc('getFloorSnapshots', { sessionId: at9.fork.sessionId })).snapshots).map(Number), [1, 2, 3, 9])
  // (6) 开场楼层。
  const at1 = await forkAt(A.sessionId, 1)
  assert.deepEqual(floorsOf(at1.session).map(floor => floor.story), [1])
  const fork1 = await exported(at1.fork.sessionId)
  assert.equal(fork1.chat.messages.length, 1)
  assert.equal(fork1.chat.messages[0].greeting, true)
  assert.deepEqual(fork1.chat.variables, { 金币: 0 })
  assert.doesNotMatch(modelText(at1.session), /进门|第二轮正文/)
  // 只有开场时，原生开场消息的标识按源存档 id 生成，Tavern 的核对报 textDrift（下次修复按同样文字重写
  // 开场节点）；正文本身一致。其余分叉由 Tavern 自己的存档/模型上下文核对确认一致。
  const alignment = async fork => (await host.rpc('storyAlignment', { sessionId: fork.fork.sessionId })).alignment
  assert.equal((await alignment(at1)).state, 'ok')
  for (const fork of [at3, at9]) assert.equal((await alignment(fork)).aligned, true)
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
  agents.get(A.sessionId).phase.kind = 'running'
  await assert.rejects(host.rpc('prepareFloorFork', { sessionId: A.sessionId, turn: 3 }), /正在生成|仍在生成/)
  agents.get(A.sessionId).phase.kind = 'idle'
  const plan = await host.rpc('prepareFloorFork', { sessionId: A.sessionId, turn: 3 })
  const stray = hostFork(A.sessionId, plan.atSeq)
  agents.get(A.sessionId).phase.kind = 'running'
  await assert.rejects(host.rpc('forkFloor', { sessionId: A.sessionId, turn: 3, targetSessionId: stray, sourceRevision: plan.sourceRevision, atSeq: plan.atSeq }), /仍在生成/)
  agents.get(A.sessionId).phase.kind = 'idle'
  // 切点或修订对不上（期间源局有变化）时拒绝绑定。
  await assert.rejects(host.rpc('forkFloor', { sessionId: A.sessionId, turn: 3, targetSessionId: stray, sourceRevision: plan.sourceRevision, atSeq: plan.atSeq - 1 }), /源对话已变化/)
  // 宿主分出的会话不是所选楼层（切点错了）时拒绝绑定。
  const wrong = hostFork(A.sessionId, (await host.rpc('prepareFloorFork', { sessionId: A.sessionId, turn: 2 })).atSeq)
  await assert.rejects(host.rpc('forkFloor', { sessionId: A.sessionId, turn: 3, targetSessionId: wrong, sourceRevision: plan.sourceRevision, atSeq: plan.atSeq }), /不一致|没有停在指定回合/)
  await assert.rejects(host.rpc('prepareFloorFork', { sessionId: A.sessionId, turn: 10 }), /不在当前上下文/)
  await assert.rejects(host.rpc('prepareFloorFork', { sessionId: A.sessionId, turn: 0 }), /分叉楼层无效/)
  assert.equal(JSON.stringify(sessionEvents(sourceA)), before.events)
  assert.equal(await saveState(A.sessionId), before.save)
  passed('5a 运行中拒绝')

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
  assert.deepEqual(floorsOf(atB.session).at(-1).history.map(item => item.current), [true, false, false])
  // (10) forkTurnsByMessageId：切换写入的替换节点也映射回故事轮 2（新流程不依赖它）。
  const switchNode = sessionEvents(sessions.get(B.sessionId)).findLast(event => event.data?.message?.source?.model === 'result-switch')
  assert.equal(forkTurnsByMessageId(sessions.get(B.sessionId), b.chat.regeneratedDshTurns)[switchNode.data.message.id], 2)
  assert.equal((await alignment(atB)).aligned, true)
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
  assert.equal((await alignment(atC)).aligned, true)
  // 重生成尝试进行中（尝试轮已开始、前台在跑）：拒绝。
  appendSessionEvent(sessions.get(C.sessionId), 'turn/start', { turn: 5 })
  appendSessionEvent(sessions.get(C.sessionId), 'user/message', { id: 'regen-5', role: 'user', content: [{ type: 'text', text: '重生成' }], source: { kind: 'plugin:dsh-tavern-regen' } }, { surfaceOp: 'append' })
  assert.equal(foldStoryRounds(sessionEvents(sessions.get(C.sessionId))).attempt?.regenerating, true)
  agents.get(C.sessionId).phase.kind = 'running'
  await assert.rejects(host.rpc('prepareFloorFork', { sessionId: C.sessionId, turn: 2 }), /仍在生成/)
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
  const atD = await forkAt(D.sessionId, 2)
  assert.deepEqual(floorsOf(atD.session).map(floor => floor.story), [1, 2])
  assert.doesNotMatch(modelText(atD.session), /D第三轮|D失败的输入|被撤回的输入/)
  assert.equal((await exported(atD.fork.sessionId)).chat.messages.at(-1).sourceText, 'D第二轮')
  assert.equal((await alignment(atD)).aligned, true)
  passed('4 撤回、打断与失败尾部不带过去也不拒绝')

  // ===== 局 E：后台结算中 =====
  const e = createGame('game-e')
  e.opening('E开场', 0)
  e.play(2, '一', 'E第二轮', 1)
  e.chat.settleStatus = 'running'
  e.save()
  const E = await importGame(e)
  await assert.rejects(host.rpc('prepareFloorFork', { sessionId: E.sessionId, turn: 2 }), /状态结算/)
  await assert.rejects(host.rpc('prepareFloorFork', { sessionId: E.sessionId, turn: 1 }), /状态结算/)
  passed('5c 后台结算中拒绝')
  console.log('floor fork rpc passed')
} finally { await host.dispose() }
