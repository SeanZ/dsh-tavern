import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { Session, adoptSessionEvent } from './fixtures/dsh-session-host.mjs'
import { appendSessionEvent, sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import { createInterruptedRoundTombstone } from '../tavern-plugin/lib/story/interrupted-round-tombstone.js'
import { rollbackAvailability, failedTurnReplayAvailability, clearFailedTurnSurface } from '../tavern-plugin/lib/domain/rollback-surface.js'
import { worldbookSnapshot } from '../tavern-plugin/lib/domain/worldbook-snapshot.js'
import { foldStoryRounds } from '../tavern-plugin/lib/story/story-rounds.js'
import { applyTavernSettingsPatch, presentTavernSettings } from '../tavern-plugin/lib/domain/tavern-settings.js'

const MODEL = { kind: 'model', provider: 'test', model: 'test' }
const SAVE = { messages: [{ role: 'assistant', greeting: true, turn: 1 }, { role: 'user' }, { role: 'assistant', turn: 2 }] }

// A story turn as the foreground writes it: the player's input, the frame's world book
// snapshot and context messages, then the reply.
function storyTurn(session, turn, input, body, end, { inputSource = { kind: 'user' }, worldbook = '世界书' + turn } = {}) {
  appendSessionEvent(session, 'turn/start', { turn })
  const seqs = { input: appendSessionEvent(session, 'user/message', { id: 'in-' + turn, role: 'user', content: [{ type: 'text', text: input }], source: inputSource }, { surfaceOp: 'append' }).seq }
  appendSessionEvent(session, 'step/start', { turn, step: 1 })
  const snapshot = worldbookSnapshot(session, worldbook)
  if (snapshot) seqs.worldbook = appendSessionEvent(session, 'user/message', { id: 'wb-' + turn, role: 'user', content: [{ type: 'text', text: snapshot.rendered }],
    source: { kind: 'plugin:dsh-tavern', form: 'worldbook-snapshot', worldbookSnapshot: snapshot, trace: { frameId: 'f' + turn, turn } } }, { surfaceOp: 'append' }).seq
  seqs.frame = appendSessionEvent(session, 'user/message', { id: 'frame-' + turn, role: 'user', content: [{ type: 'text', text: '【本轮状态】' + turn }],
    source: { kind: 'plugin:dsh-tavern', form: 'foreground-frame', trace: { frameId: 'f' + turn, turn } } }, { surfaceOp: 'append' }).seq
  if (body !== null) seqs.reply = appendSessionEvent(session, 'assistant/message', { turn, step: 1, message: { id: 'reply-' + turn, role: 'assistant', content: [{ type: 'text', text: body }], source: MODEL } }, { surfaceOp: 'append' }).seq
  appendSessionEvent(session, 'step/end', { turn, step: 1 })
  appendSessionEvent(session, 'turn/end', { turn, reason: end === 'error' ? { kind: 'error', error: { message: 'x', code: 'UNKNOWN' } } : { kind: end } })
  return seqs
}
function game(id) {
  const session = Session.create(id)
  appendSessionEvent(session, 'turn/start', { turn: 1 })
  appendSessionEvent(session, 'step/start', { turn: 1, step: 1 })
  appendSessionEvent(session, 'assistant/message', { turn: 1, step: 1, message: { id: 'greeting', role: 'assistant', content: [{ type: 'text', text: '开场白' }], source: MODEL } }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'step/end', { turn: 1, step: 1 })
  appendSessionEvent(session, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  storyTurn(session, 2, '你好', '第二轮正文', 'completed', { worldbook: '同一条世界书' })
  return session
}
function tombstone(session, { enabled = true, chat = SAVE } = {}) {
  const flushed = []
  const run = createInterruptedRoundTombstone({ enabled: async () => enabled, sessionFor: id => (id === session.id ? session : undefined),
    latestChat: async () => chat, flush: async target => { flushed.push(target.id) }, logger: { warn() {} } })
  return { run: turn => run({ sessionId: session.id, turn }), flushed }
}
const modelText = session => JSON.stringify(session.deriveMessages())
const coldRead = session => {
  const persisted = JSON.parse(JSON.stringify(sessionEvents(session)))
  for (const event of persisted) adoptSessionEvent(event)
  return Session.create(session.id, persisted, session.header)
}

test('故事视图模式设置：默认关闭，只接受布尔值', () => {
  assert.equal(presentTavernSettings({}, {}).storyViewMode, false)
  assert.equal(presentTavernSettings(applyTavernSettingsPatch({}, { storyViewMode: true }), {}).storyViewMode, true)
  assert.equal(presentTavernSettings(applyTavernSettingsPatch({ storyViewMode: true }, { storyViewMode: false }), {}).storyViewMode, false)
  assert.throws(() => applyTavernSettingsPatch({}, { storyViewMode: 'on' }), /布尔值/)
})

for (const end of ['aborted', 'error', 'interrupted']) {
  test(`打断/失败（${end}）结束即打墓碑：模型上下文不含该轮输入、frame 与半截正文，日志完整，冷读一致`, async () => {
    const session = game('tombstone-' + end)
    const cut = storyTurn(session, 3, '说到一半', '半截正文', end, { worldbook: '只在这一轮触发' })
    const before = session.surface.nodes.slice()
    const { run, flushed } = tombstone(session)
    assert.equal(await run(3), 4)
    assert.deepEqual(flushed, [session.id])
    // The replacement covers exactly this turn's input through its partial reply.
    const written = sessionEvents(session).at(-1)
    assert.deepEqual(written.sourceEventSeqs, [cut.input, cut.worldbook, cut.frame, cut.reply])
    assert.deepEqual(session.surface.nodes, before.slice(0, before.indexOf(cut.input)).concat([written.seq]))
    for (const text of ['说到一半', '半截正文', '只在这一轮触发', '【本轮状态】3']) assert.doesNotMatch(modelText(session), new RegExp(text))
    assert.match(modelText(session), /第二轮正文/)
    // The log keeps every event; a cold read derives the same model history.
    assert.ok(sessionEvents(session).some(event => event.data?.message?.content?.[0]?.text === '半截正文'))
    assert.equal(JSON.stringify(coldRead(session).deriveMessages()), modelText(session))
    // Retrying the same turn later is a no-op, not a second tombstone.
    assert.equal(await run(3), 0)
    assert.equal(clearFailedTurnSurface({ session, turn: 3 }), 0)
  })
}

test('墓碑后下一轮重发同一份世界书快照：去重读的是消息面而不是日志', async () => {
  const session = game('tombstone-worldbook')
  storyTurn(session, 3, '说到一半', '半截', 'aborted', { worldbook: '本轮新触发' })
  // Before: the failed turn's snapshot still counts, so the next turn would skip it.
  assert.equal(worldbookSnapshot(session, '本轮新触发'), null)
  await tombstone(session).run(3)
  assert.equal(worldbookSnapshot(session, '本轮新触发')?.text, '本轮新触发')
  // A snapshot of a kept round is still deduplicated.
  assert.equal(worldbookSnapshot(session, '同一条世界书'), null)
})

test('后续新消息不被盖掉：墓碑落地前玩家已发出的新输入与新回合都留在模型上下文', async () => {
  const session = game('tombstone-race')
  storyTurn(session, 3, '说到一半', '半截', 'aborted')
  // The player sends again before the deferred hook runs (queued, then its turn starts).
  const queued = appendSessionEvent(session, 'user/message', { id: 'next', role: 'user', content: [{ type: 'text', text: '新的输入' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'turn/start', { turn: 4 })
  assert.equal(await tombstone(session).run(3), 4)
  assert.ok(session.surface.nodes.includes(queued.seq))
  assert.match(modelText(session), /新的输入/)
  assert.doesNotMatch(modelText(session), /说到一半|半截/)
  appendSessionEvent(session, 'step/start', { turn: 4, step: 1 })
  appendSessionEvent(session, 'assistant/message', { turn: 4, step: 1, message: { id: 'reply-4', role: 'assistant', content: [{ type: 'text', text: '第四轮正文' }], source: MODEL } }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'step/end', { turn: 4, step: 1 })
  appendSessionEvent(session, 'turn/end', { turn: 4, reason: { kind: 'completed' } })
  const rounds = foldStoryRounds(sessionEvents(session))
  assert.deepEqual(rounds.floors.map(floor => [floor.story, floor.inputs.map(input => input.text).join(), floor.reply.text]), [[1, '', '开场白'], [2, '你好', '第二轮正文'], [4, '新的输入', '第四轮正文']])
  assert.deepEqual(rounds.abandoned.map(item => [item.text, item.reason]), [['说到一半', 'aborted']])
})

test('开关关闭、已存档的回合、重新生成尝试轮、成功回合：都不写任何东西', async () => {
  const off = game('tombstone-off')
  storyTurn(off, 3, '说到一半', '半截', 'aborted')
  const events = sessionEvents(off).length
  assert.equal(await tombstone(off, { enabled: false }).run(3), 0)
  // Saved before the stop (finalize ran, then the turn was aborted): the round is story.
  assert.equal(await tombstone(off, { chat: { messages: [...SAVE.messages, { role: 'user' }, { role: 'assistant', turn: 3 }] } }).run(3), 0)
  assert.equal(await tombstone(off, { chat: { ...SAVE, regeneratedDshTurns: { 2: 3 } } }).run(3), 0)
  assert.equal(await tombstone(off).run(2), 0)
  assert.equal(sessionEvents(off).length, events)
  assert.match(modelText(off), /半截/)
  const regen = game('tombstone-regen')
  storyTurn(regen, 3, '重生成', '半截', 'aborted', { inputSource: { kind: 'plugin:dsh-tavern-regen' } })
  const regenEvents = sessionEvents(regen).length
  assert.equal(await tombstone(regen).run(3), 0)
  assert.equal(sessionEvents(regen).length, regenEvents)
})

test('与既有失败轮流程并存：重试、撤回清理与下一次发送前的清理照常工作', async () => {
  const session = game('tombstone-coexist')
  storyTurn(session, 3, '说到一半', '半截', 'aborted')
  await tombstone(session).run(3)
  const input = { events: sessionEvents(session), nodes: session.surface.nodes }
  // Retry (replayFailedTurn) still finds the input in the log.
  const replay = failedTurnReplayAvailability(input)
  assert.equal(replay.target?.turn, 3)
  assert.equal(replay.target?.userText, '说到一半')
  // Withdraw still sees the pending failure; the next send has nothing left to clear.
  const availability = rollbackAvailability(SAVE, input)
  assert.deepEqual(availability.failedTurns, [3])
  assert.deepEqual(availability.unclearedTurns, [])
})

test('墓碑后的会话满足已发布 V4 关系约束', { skip: !process.env.DSH_BOOT_MODULE, timeout: 30000 }, async () => {
  const session = game('tombstone-v4')
  storyTurn(session, 3, '说到一半', '半截', 'aborted')
  await tombstone(session).run(3)
  const { assertReleasedV4Relationships } = await import(new URL('../../dsh-session-format-v3-to-v4/lib/index.js', pathToFileURL(process.env.DSH_BOOT_MODULE)))
  const events = sessionEvents(session)
  assertReleasedV4Relationships({ header: session.header, events, inheritedEventCount: 0 }, new Set(events.map(event => event.type)))
})

test('故事生命周期开关决定失败尾部墓碑，清理后原生日志保留', async () => {
  const { createStoryLifecycle } = await import('../tavern-plugin/lib/story/service.js')
  const session = game('tombstone-lifecycle')
  storyTurn(session, 3, '失败输入', '半截正文', 'aborted')
  let enabled = false, flushed = 0
  const lifecycle = createStoryLifecycle({ settings: async () => ({ storyViewMode: enabled }), sessionFor: () => session,
    latestChat: async () => SAVE, flush: async () => flushed++ })
  assert.equal(await lifecycle.tombstoneInterruptedRound({ sessionId: session.id, turn: 3 }), 0)
  assert.match(modelText(session), /半截正文/)
  enabled = true
  assert.ok(await lifecycle.tombstoneInterruptedRound({ sessionId: session.id, turn: 3 }) > 0)
  assert.doesNotMatch(modelText(session), /半截正文/)
  assert.ok(JSON.stringify(sessionEvents(session)).includes('半截正文'))
  assert.equal(flushed, 1)
})

// The host catalog and JSONL persistence decide whether a log opens; read the tombstoned
// game back from disk the way a restart does.
test('JSONL 冷读：墓碑后的日志经宿主持久化写盘再读回，模型上下文仍不含半截正文', { skip: !process.env.DSH_BOOT_MODULE, timeout: 30000 }, async t => {
  const { createRequire } = await import('node:module')
  const { fileURLToPath } = await import('node:url')
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { encodeCurrentGeneration } = await import('../tavern-plugin/lib/domain/session-log-codec.js')
  const bootModule = pathToFileURL(process.env.DSH_BOOT_MODULE)
  const hostRequire = createRequire(fileURLToPath(bootModule))
  const load = name => import(pathToFileURL(hostRequire.resolve(name)).href)
  const { sessionFormatCatalog: catalog } = await load('@deepseek-ai/dsh-session-format-catalog')
  const { Context } = await load('@deepseek-ai/cordis')
  const loaded = await load('@deepseek-ai/dsh-session-persistence-jsonl')
  const Jsonl = typeof loaded.apply === 'function' ? loaded : loaded.default

  const session = game('tombstone-jsonl')
  storyTurn(session, 3, '说到一半', '半截正文', 'aborted')
  await tombstone(session).run(3)
  const header = { type: 'session', version: 4, id: session.id, createdAt: 1, cwd: '/tmp', isSeeded: false, delegationDepth: 0, agentPreset: 'tavern' }
  const restore = catalog.createRestore(header, { recovery: 'strict', validation: 'current' })
  for (const event of sessionEvents(session)) restore.decodeRow(structuredClone(event))
  const artifact = restore.finish()

  const root = await mkdtemp(path.join(tmpdir(), 'tavern-tombstone-jsonl-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  await ctx.plugin(Jsonl, { root: path.join(root, 'sessions'), compression: 'zstd' }).await()
  t.after(() => ctx.fiber.dispose())
  const persistence = ctx.sessionPersistence
  const file = persistence.locate(artifact.header).path
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, encodeCurrentGeneration(artifact, catalog))
  const handle = await persistence.open(header.id, 'read')
  const { events } = await handle.read(0)
  await handle.close()
  const reread = Session.create(session.id, events, session.header)
  assert.doesNotMatch(JSON.stringify(reread.deriveMessages()), /说到一半|半截正文/)
  assert.match(JSON.stringify(reread.deriveMessages()), /第二轮正文/)
  assert.ok(events.some(event => event.data?.message?.content?.[0]?.text === '半截正文'))
  assert.deepEqual(foldStoryRounds(events).floors.map(floor => floor.story), [1, 2])
})
