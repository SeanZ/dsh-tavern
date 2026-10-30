// Dialogue bubbles: the story model names the speaker of each spoken line (docs/design/cast-presentation.md, 30/N).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sourceFunction } from './fixtures/source-function.mjs'
import { dialogueBubbleLines, dialogueBubblePlainText, CAST_EMOTIONS } from '../tavern-plugin/lib/domain/dialogue-bubbles.js'
import { parseBubbles } from '../tavern-plugin/src/client/bubble-line.cjs'
import { dialogueFormatText, dialogueFormatUpdate } from '../tavern-plugin/lib/domain/dialogue-format.js'
import { createContextPlanner } from '../tavern-plugin/lib/domain/context-planner.js'
import { createForegroundFrameBuilder } from '../tavern-plugin/lib/domain/agent-input-frame.js'
import { createForegroundFrameSessionAdapter } from '../tavern-plugin/lib/domain/foreground-frame-session-adapter.js'
import { createCastPresentation } from '../tavern-plugin/lib/domain/cast-presentation.js'
import { CAST_DATA_OWNER } from '../tavern-plugin/lib/domain/cast-annotation.js'
import { createPluginData } from '../tavern-plugin/lib/domain/plugin-data.js'

const reply = [
  '店主擦着杯子抬起头。',
  '@bubble:shopkeeper|店主|开心|[欢迎回来。]',
  '*@bubble:lin_yue|林月|紧张|[*他还记得我吗？*]*',
  '@bubble:passer_by|路人｜surprise｜你也来了？',
  '@bubble:oops',
  '@bubble:lee|Lee|blushing|[Hi.]',
  '门外传来脚步声。'
].join('\n')

test('the format lists the card cast with a handle each and the 28 emotion labels as variants', () => {
  const text = dialogueFormatText([{ name: '林月', aliases: ['小月', 'Lin Yue'] }, { name: '老周' }, { name: '老周' }, { name: 'Nora' }, { name: 'nora' }, { name: '' }])
  assert.match(text, /^<dialogue_format>\n/)
  assert.match(text, /`@bubble:handle\|name\|variant\|\[text\]`/)
  assert.match(text, new RegExp('Variants: ' + Object.values(CAST_EMOTIONS).join('、') + '\n'))
  assert.deepEqual([.../<speaker_roster>[^]*<\/speaker_roster>/.exec(text)[0].matchAll(/^- (.*)$/gm)].map(match => match[1]), ['lin_yue|林月', '老周|老周', 'nora|Nora', 'nora_2|nora'])
  assert.equal(dialogueFormatText(), dialogueFormatText([]))
  assert.match(dialogueFormatText(), /Variants: [^\n]+\n<\/speaker_roster>/, 'no cast: every speaker is unlisted and still picks a variant')
})

test('the planner gives the body the format only with 对话气泡 on; the update is sent once, resent when lost, taken back when off', async () => {
  const planner = createContextPlanner({ prompt: () => '正文写作规则' })
  const card = { name: '角色' }, chat = { guides: [], posture: '' }
  assert.equal((await planner.plan({ purpose: 'body', card, chat })).dialogueFormatText, '')
  const on = await planner.plan({ purpose: 'body', card, chat, dialogueSpeakers: [{ name: '店主' }] })
  assert.equal(on.dialogueFormatText, dialogueFormatText([{ name: '店主' }]))
  assert.doesNotMatch(on.text, /@bubble/, 'not part of the per-turn context')

  // The model context as the adapter reads it: the session's user messages on its surface.
  const session = { events: [], surface: { nodes: [] } }
  const adapter = createForegroundFrameSessionAdapter()
  let turn = 0
  const send = text => {
    const frame = createForegroundFrameBuilder().build({ chatId: 'chat', branchId: 'branch', basedOnRevision: turn, operationId: 'op-' + ++turn, turn,
      inputs: [{ kind: 'foreground.user-input', sourceText: '继续' }], source: { card: { systemPromptText: '' }, dialogueFormatText: text } })
    const { messages } = adapter.append({ session, messages: [], frame, step: 1 })
    for (const message of messages) { session.events.push({ seq: session.events.length + 1, type: 'user/message', data: message }); session.surface.nodes.push(session.events.length) }
    return messages.filter(message => message.source.form === 'dialogue-format-update').map(message => message.content[0].text)
  }
  assert.deepEqual(send(''), [], 'never on: nothing to send')
  const [first] = send(on.dialogueFormatText)
  assert.match(first, /^【对白格式 · [0-9a-f]{16}】\n/)
  assert.ok(first.endsWith(on.dialogueFormatText))
  assert.deepEqual(send(on.dialogueFormatText), [], 'unchanged: the cached prefix stays as it was')
  const roster = dialogueFormatText([{ name: '店主' }, { name: '林月' }])
  assert.equal(send(roster).length, 1, 'a new speaker in 舞台素材 resends the format')
  assert.match(send('')[0], /不再加 @bubble 标记/)
  assert.deepEqual(send(''), [])
  session.surface.nodes = []
  assert.ok(dialogueFormatUpdate(session, roster), 'compacted or rewound away: sent again')
})

function castHarness(shown) {
  const files = new Map()
  const data = createPluginData({ store: {
    async readJson(path) { return files.has(path) ? structuredClone(files.get(path)) : undefined },
    async updateJson(path, change) { const next = change(files.has(path) ? structuredClone(files.get(path)) : undefined); files.set(path, next); return next }
  } })
  const turns = {
    resolveGame: async () => ({ chatId: 'chat', sessionId: 'game' }),
    currentKey: async (_id, turn) => shown[turn]?.key || null,
    readTurn: async (_id, turn = 3) => shown[turn] && { chatId: 'chat', sessionId: 'game', turn, ...shown[turn] }
  }
  const published = []
  const state = { enabled: true }
  const cast = createCastPresentation({ enabled: async () => state.enabled, turns, data, publish: (id, annotation) => published.push([id, annotation]) })
  return { cast, data, published, state }
}

test('a turn\'s lines come from its shown bubbles, without settlement; an earlier annotated turn keeps its annotation', async () => {
  const shown = { 2: { key: 'v1', text: '她说：“你好。”' }, 3: { key: 'v7', text: reply } }
  const { cast, data, published, state } = castHarness(shown)
  await data.saveTurn({ chatId: 'chat', owner: CAST_DATA_OWNER, turn: 2, key: 'v1', data: { version: 1, lines: [{ n: 1, quote: '你好。', speaker: '林曦', emotion: 'joy' }] } })
  const read = await cast.forTurns('game', [2, 3, 4])
  assert.deepEqual(Object.keys(read.turns), ['2', '3'])
  assert.equal(read.turns[2][0].speaker, '林曦')
  assert.deepEqual(read.turns[3], dialogueBubbleLines(parseBubbles(reply)))
  assert.deepEqual(await cast.annotation('game', 3), { turn: 3, textVersion: 'v7', lines: dialogueBubbleLines(parseBubbles(reply)) })
  shown[3] = { key: 'v8', text: '@bubble:lee|Lee|开心|[Again.]' }
  assert.deepEqual((await cast.forTurns('game', [3])).turns[3], [{ n: 1, quote: 'Again.', speaker: 'Lee', emotion: 'joy' }], 'a regenerated or edited reply reads its own text')
  assert.equal((await data.turnsUpTo({ chatId: 'chat', owner: CAST_DATA_OWNER, turn: 3 })).length, 1, 'nothing stored for bubble turns')
  await cast.announce('game')
  assert.deepEqual(published, [['game', { turn: 3, textVersion: 'v8', lines: [{ n: 1, quote: 'Again.', speaker: 'Lee', emotion: 'joy' }] }]])
  state.enabled = false
  assert.deepEqual(await cast.forTurns('game', [3]), { enabled: false, turns: {} })
  assert.ok(await cast.annotation('game', 3), 'plugins read the lines whether or not 对话气泡 is on')
})

// The chat: with 对话气泡 on a reply shows a row per bubble, while it streams too (32/N); otherwise name：“line”.
const castSource = readFileSync(new URL('../tavern-plugin/src/client/features/cast-presentation.js', import.meta.url), 'utf8')
const bubbleLineSource = readFileSync(new URL('../tavern-plugin/src/client/bubble-line.cjs', import.meta.url), 'utf8')
// 正文渲染前会先过自动分段（features/prose-layout.js），沙箱里也要带上这份源码。
const proseSource = readFileSync(new URL('../tavern-plugin/src/client/features/prose-layout.js', import.meta.url), 'utf8')
const bubbleSource = readFileSync(new URL('../tavern-plugin/lib/domain/dialogue-bubbles.js', import.meta.url), 'utf8').replace(/^export \{[^}]+\};?$/gm, '')
const castStateSource = readFileSync(new URL('../tavern-plugin/lib/domain/cast-stage-state.js', import.meta.url), 'utf8').replace(/^export \{[^}]+\};?$/gm, '')
const client = new Function('React', 'TAVERN_CAST_EMOTIONS', 'TavernCastAvatar', 'TavernCastSpeak', 'tavernCastLineAvatar', 'tavernCastHue', proseSource + '\n' + bubbleLineSource + '\n' + bubbleSource + '\n' + castStateSource + '\n'
  + ['TavernCastRow', 'renderTavernDialogueText'].map(name => sourceFunction(castSource, name)).join('\n')
  + '\nreturn { renderTavernDialogueText, TavernCastRow }')
const h = (type, props, ...children) => ({ type, props: props || {}, children })
const ui = client({ createElement: h, Fragment: 'fragment' }, CAST_EMOTIONS, 'avatar', 'speak', () => '', () => 0)
const flat = node => !node || typeof node !== 'object' ? (node == null ? [] : [node]) : node.type === ui.TavernCastRow ? [node] : node.children.flat(Infinity).flatMap(flat)

const plain = (text, key) => h('md', { key }, text)
const shown = node => [node.props.speaker, node.props.emotion, node.props.speech, node.children[0].children[0]]
const cast = { sessionId: 'game', lines: [], characters: [] }

test('chat: speaker rows for a finished reply; name：“line” without speakers', () => {
  const rows = flat(ui.renderTavernDialogueText(reply, 0, plain, cast, false)).filter(node => node.type === ui.TavernCastRow)
  assert.deepEqual(rows.map(shown), [
    ['店主', 'joy', '欢迎回来。', '欢迎回来。'], ['林月', 'nervousness', '他还记得我吗？', '（他还记得我吗？）'], ['路人', 'surprise', '你也来了？', '你也来了？'], ['Lee', 'neutral', 'Hi.', 'Hi.']])
  assert.deepEqual(ui.renderTavernDialogueText(reply, 0, plain, null, false), h('md', { key: 0 }, dialogueBubblePlainText(parseBubbles(reply))))
  assert.deepEqual(ui.renderTavernDialogueText(reply + '\n@bubble:lee|Lee|开心|[Wai', 0, plain, null, true), h('md', { key: 0 }, dialogueBubblePlainText(parseBubbles(reply)) + '\n\nLee：“Wai'))
  // An earlier turn's stored annotation is for the stage and plugins: its quotes are not matched into rows.
  assert.deepEqual(ui.renderTavernDialogueText('她说：“你好。”', 0, plain, { ...cast, lines: [{ n: 1, quote: '你好。', speaker: '林曦', emotion: 'joy' }] }, false), h('md', { key: 0 }, '她说：“你好。”'))
})

test('chat while streaming: each bubble is its row as its text starts, earlier rows keep their place, no markup', () => {
  const steps = ['店主擦着杯子抬起头。\n@bub', '店主擦着杯子抬起头。\n@bubble:shopkeeper|店主|开心|', '店主擦着杯子抬起头。\n@bubble:shopkeeper|店主|开心|[欢迎',
    '店主擦着杯子抬起头。\n@bubble:shopkeeper|店主|开心|[欢迎回来。]\n@bubble:lin_yue|林月|紧张|[*他还', reply]
  const frames = steps.map(text => ui.renderTavernDialogueText(text, 0, plain, cast, text !== reply))
  const rows = frames.map(frame => flat(frame).filter(node => node.type === ui.TavernCastRow))
  assert.deepEqual(frames[0], h('md', { key: 0 }, '店主擦着杯子抬起头。'), 'a line too short to read shows nothing')
  assert.deepEqual(frames[1], h('md', { key: 0 }, '店主擦着杯子抬起头。'))
  assert.deepEqual(rows[2].map(shown), [['店主', 'joy', '', '欢迎']], 'the row shows with the first words; nothing to read aloud yet')
  assert.deepEqual(rows[3].map(shown), [['店主', 'joy', '欢迎回来。', '欢迎回来。'], ['林月', 'nervousness', '', '（他还']], 'an unfinished thought has no closing bracket')
  assert.deepEqual(rows.slice(2).map(list => list.map(row => row.props.key)), [[1], [1, 2], [1, 2, 3, 4]], 'rows keep their keys from the first words to the finished reply')
  assert.equal(JSON.stringify(frames).includes('@bub'), false)
})
