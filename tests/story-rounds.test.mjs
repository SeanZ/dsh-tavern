import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { Session } from './fixtures/dsh-session-host.mjs'
import { appendSessionEvent, sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import { replaceSessionSurface } from '../tavern-plugin/lib/domain/session-surface-mutations.js'
import { reshadowRolledBackRounds, clearFailedTurnSurface, planRegenerationSurface, regenerationProjection, applyRegenerationProjection } from '../tavern-plugin/lib/domain/rollback-surface.js'
import { createStoryRoundsFold, foldStoryRounds } from '../tavern-plugin/lib/domain/story-rounds.js'

const MODEL = { kind: 'model', provider: 'test', model: 'test' }
const player = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const frame = (id, turn) => ({ id, role: 'user', content: [{ type: 'text', text: '【本轮世界书上下文】' + turn }], source: { kind: 'plugin:dsh-tavern', form: 'foreground-frame', trace: { turn } } })
const reply = (id, turn, text, source = MODEL) => ({ turn, step: 1, message: { id, role: 'assistant', content: [{ type: 'text', text }], source } })

// A native turn the way the foreground writes it: input, the turn's frame context, the reply.
function playTurn(session, turn, input, body, end = 'completed') {
  appendSessionEvent(session, 'turn/start', { turn })
  const seqs = {}
  if (input !== null) seqs.input = appendSessionEvent(session, 'user/message', player('in-' + turn, input), { surfaceOp: 'append' }).seq
  appendSessionEvent(session, 'step/start', { turn, step: 1 })
  if (input !== null) seqs.frame = appendSessionEvent(session, 'user/message', frame('frame-' + turn, turn), { surfaceOp: 'append' }).seq
  if (body !== null) seqs.reply = appendSessionEvent(session, 'assistant/message', reply('reply-' + turn, turn, body), { surfaceOp: 'append' }).seq
  appendSessionEvent(session, 'step/end', { turn, step: 1 })
  if (end !== null) appendSessionEvent(session, 'turn/end', { turn, reason: { kind: end } })
  return seqs
}
function game(id) {
  const session = Session.create(id)
  playTurn(session, 1, null, '开场白')
  playTurn(session, 2, '你好', '第二轮正文')
  playTurn(session, 3, '继续', '第三轮正文')
  return session
}
// Tavern's regeneration: an attempt turn, then the body projected over the old reply.
function regenerate(session, story, attemptTurn, text, operationId) {
  const events = sessionEvents(session)
  const old = session.surface.nodes.map(seq => events[seq]).findLast(event => event.type === 'assistant/message' && (event.data.message.source.tavernStoryTurn ?? event.data.turn) === story)
  const eventStart = events.length
  appendSessionEvent(session, 'turn/start', { turn: attemptTurn })
  appendSessionEvent(session, 'user/message', { id: 'regen-' + attemptTurn, role: 'user', content: [{ type: 'text', text: '重生成' }], source: { kind: 'plugin:dsh-tavern-regen' } }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'step/start', { turn: attemptTurn, step: 1 })
  appendSessionEvent(session, 'assistant/message', reply('attempt-' + attemptTurn, attemptTurn, text), { surfaceOp: 'append' })
  appendSessionEvent(session, 'step/end', { turn: attemptTurn, step: 1 })
  appendSessionEvent(session, 'turn/end', { turn: attemptTurn, reason: { kind: 'completed' } })
  const before = foldStoryRounds(sessionEvents(session))
  const plan = planRegenerationSurface({ events: sessionEvents(session), nodes: session.surface.nodes, oldAssistantSeq: old.seq, eventStart })
  applyRegenerationProjection(session, regenerationProjection(plan, reply('tavern-regen:' + operationId, story, text, { ...MODEL, tavernStoryTurn: story }), operationId))
  return before
}
const shape = rounds => rounds.floors.map(floor => [floor.story, floor.inputs.map(input => input.text).join('|'), floor.reply.text])

test('正常交替：开场无输入，每轮一条玩家输入配一条已结算正文；frame 上下文不成楼层', () => {
  const rounds = foldStoryRounds(sessionEvents(game('story-rounds-plain')))
  assert.deepEqual(shape(rounds), [[1, '', '开场白'], [2, '你好', '第二轮正文'], [3, '继续', '第三轮正文']])
  assert.deepEqual(rounds.abandoned, [])
  assert.equal(rounds.open, null)
  assert.deepEqual(rounds.floors[2].history.map(item => [item.text, item.current]), [['第三轮正文', true]])
})

test('撤回 replace：被墓碑覆盖的回合不再是楼层，列入废弃；之后的新回合照常接上', () => {
  const session = game('story-rounds-rollback')
  assert.deepEqual(reshadowRolledBackRounds(session, new Set([3])), [3])
  let rounds = foldStoryRounds(sessionEvents(session))
  assert.deepEqual(shape(rounds), [[1, '', '开场白'], [2, '你好', '第二轮正文']])
  assert.deepEqual(rounds.abandoned.map(item => [item.turn, item.text, item.reason]), [[3, '继续', 'rolled-back']])
  playTurn(session, 5, '换个说法', '新的第三轮')
  rounds = foldStoryRounds(sessionEvents(session))
  assert.deepEqual(shape(rounds).at(-1), [5, '换个说法', '新的第三轮'])
  assert.equal(rounds.floors.length, 3)
})

test('重生成 replace：尝试轮不另起楼层；落定后同一楼层换正文，历史结果可列出与切换', () => {
  const session = game('story-rounds-regen')
  const during = regenerate(session, 3, 4, '重写一', 'op-1')
  // While the attempt waits for its projection, the round still shows its old body once.
  assert.deepEqual(shape(during), [[1, '', '开场白'], [2, '你好', '第二轮正文'], [3, '继续', '第三轮正文']])
  let rounds = foldStoryRounds(sessionEvents(session))
  assert.deepEqual(shape(rounds), [[1, '', '开场白'], [2, '你好', '第二轮正文'], [3, '继续', '重写一']])
  regenerate(session, 3, 6, '重写二', 'op-2')
  rounds = foldStoryRounds(sessionEvents(session))
  const floor = rounds.floors.at(-1)
  assert.equal(floor.reply.text, '重写二')
  assert.equal(floor.reply.id, 'tavern-regen:op-2')
  assert.deepEqual(floor.history.map(item => [item.text, item.current]), [['第三轮正文', false], ['重写一', false], ['重写二', true]])
  assert.deepEqual(rounds.abandoned, [])
})

test('打断：半截正文与该轮输入不成楼层，打墓碑前后都列为废弃，后续新消息照常成楼层', () => {
  const session = game('story-rounds-interrupted')
  const cut = playTurn(session, 4, '说到一半', '半截', 'aborted')
  let rounds = foldStoryRounds(sessionEvents(session))
  assert.deepEqual(shape(rounds).map(row => row[0]), [1, 2, 3])
  assert.deepEqual(rounds.abandoned.map(item => [item.seq, item.reason]), [[cut.input, 'aborted']])
  assert.equal(clearFailedTurnSurface({ session, turn: 4 }), 3)
  rounds = foldStoryRounds(sessionEvents(session))
  assert.deepEqual(shape(rounds).map(row => row[0]), [1, 2, 3])
  assert.deepEqual(rounds.abandoned.map(item => [item.seq, item.text, item.reason]), [[cut.input, '说到一半', 'aborted']])
  playTurn(session, 5, '重新说', '完整正文')
  rounds = foldStoryRounds(sessionEvents(session))
  assert.deepEqual(shape(rounds).at(-1), [5, '重新说', '完整正文'])
  // A turn the server stopped without ever ending is cut off the same way.
  const crash = Session.create('story-rounds-crash')
  playTurn(crash, 1, '一', '一的正文')
  playTurn(crash, 2, '二', '半截', null)
  playTurn(crash, 3, '三', '三的正文')
  const crashed = foldStoryRounds(sessionEvents(crash))
  assert.deepEqual(shape(crashed), [[1, '一', '一的正文'], [3, '三', '三的正文']])
  assert.deepEqual(crashed.abandoned.map(item => [item.turn, item.reason]), [[2, 'interrupted']])
})

test('运行中的回合放在 open；编辑过的输入以新文字留在楼层，不算废弃', () => {
  const session = game('story-rounds-open')
  const second = sessionEvents(session).find(event => event.data?.id === 'in-2')
  replaceSessionSurface(session, 'user/message', player('tavern-user-edit:1', '你好呀'), { start: second.seq, end: second.seq, sourceEventSeqs: [second.seq] })
  playTurn(session, 4, '还在写', '写到这里', null)
  const rounds = foldStoryRounds(sessionEvents(session))
  assert.deepEqual(shape(rounds)[1], [2, '你好呀', '第二轮正文'])
  assert.deepEqual(rounds.abandoned, [])
  assert.equal(rounds.open.turn, 4)
  assert.deepEqual(rounds.open.inputs.map(input => input.text), ['还在写'])
  assert.equal(rounds.open.reply.text, '写到这里')
})

test('逐条喂入与一次喂完结果相同，重复喂入的事件被跳过', () => {
  const session = game('story-rounds-incremental')
  regenerate(session, 3, 4, '重写', 'op')
  reshadowRolledBackRounds(session, new Set([3]))
  playTurn(session, 6, '新的', '新正文')
  const events = sessionEvents(session)
  const fold = createStoryRoundsFold()
  for (let index = 0; index < events.length; index++) { fold.addEvents(events.slice(0, index + 1)); fold.result() }
  assert.deepEqual(fold.result(), foldStoryRounds(events))
  assert.equal(fold.folded, events.at(-1).seq)
})

// The client's first page starts at some event, often after a turn/start: the turn's own
// events (its steps, its end) say which turn its input belongs to.
test('窗口从回合中间开始：输入按该轮 step/turn/end 归属，下一轮失败也不误列废弃；无法判断时 turn 为 null', () => {
  for (const failure of ['aborted', 'error']) {
    const session = game('story-rounds-window-' + failure)
    playTurn(session, 4, '下一轮', '半截', failure)
    const events = sessionEvents(session)
    const start = events.findIndex(event => event.type === 'turn/start' && event.data.turn === 3)
    const tail = events.slice(start + 1)
    // With its steps, and with only the reply and turn/end naming the turn.
    for (const [from, window] of [['steps', tail], ['no-steps', tail.filter(event => !event.type.startsWith('step/'))]]) {
      const rounds = foldStoryRounds(window)
      const floor = rounds.floors.find(item => item.story === 3)
      assert.deepEqual(floor.inputs.map(input => [input.text, input.turn]), [['继续', 3]], '窗口起点 ' + from)
      assert.deepEqual(rounds.abandoned.map(item => [item.text, item.turn, item.reason]), [['下一轮', 4, failure]])
    }
  }
  // Only the input and nothing that names its turn: unknown, never abandoned.
  const session = game('story-rounds-window-unknown')
  const input = sessionEvents(session).find(event => event.data?.id === 'in-3')
  const rounds = foldStoryRounds([input])
  assert.deepEqual(rounds.abandoned, [])
  assert.deepEqual(rounds.open.inputs.map(item => [item.text, item.turn]), [['继续', null]])
})

// The #311 log (tests/fixtures/transcript/issue-311.json): an old save repaired many times
// and rolled back twice. The save holds the opening and rounds 2, 3, 5 and 12.
test('#311 旧存档日志：楼层正是存档里的开场与 2、3、5、12 轮，修复副本不重复，两次撤回列为废弃', async () => {
  const { events } = JSON.parse(await readFile(new URL('./fixtures/transcript/issue-311.json', import.meta.url), 'utf8'))
  const rounds = foldStoryRounds(events)
  assert.deepEqual(rounds.floors.map(floor => floor.story), [1, 2, 3, 5, 12])
  assert.deepEqual(rounds.floors.map(floor => floor.inputs.length), [0, 1, 1, 1, 1])
  assert.deepEqual(rounds.abandoned.map(item => item.reason), ['rolled-back', 'rolled-back'])
  assert.equal(rounds.open, null)
})

test('可经 @include-domain 嵌入浏览器脚本：无 import、无 Node 依赖，结果与 Node 一致', async () => {
  const source = await readFile(new URL('../tavern-plugin/lib/domain/story-rounds.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /^\s*import\s/m)
  // The same transform bin/build-tavern-client.mjs applies to included domain files.
  const embedded = source.replace(/^export \{[^}]+\};?$/gm, '')
  assert.doesNotMatch(embedded, /\bexport\b/)
  const session = game('story-rounds-browser')
  regenerate(session, 3, 4, '重写', 'op')
  const events = JSON.parse(JSON.stringify(sessionEvents(session)))
  const context = vm.createContext({ events })
  new vm.Script(embedded + '\n;globalThis.result = JSON.stringify(foldStoryRounds(events))').runInContext(context)
  assert.deepEqual(JSON.parse(context.result), foldStoryRounds(events))
})
