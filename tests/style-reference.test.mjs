import assert from 'node:assert/strict'
import test from 'node:test'

import { styleReferenceReplyText, createStyleReferenceRecall, latestStyleReference, readStyleReference, rememberStyleReference, styleReferenceFor } from '../tavern-plugin/lib/domain/style-reference.js'
import { createContextPlanner } from '../tavern-plugin/lib/domain/context-planner.js'
import { normalizeBackgroundTasks, normalizePlayDefaults } from '../tavern-plugin/lib/domain/tavern-settings.js'

const ref = (afterTurn, book = '边城') => ({ book, author: '沈从文', quote: '小溪流下去，绕山岨流。', afterTurn })

test('新游戏默认开启文风联想（全局默认可关）；没有这项的旧存档保持关闭', () => {
  assert.equal(normalizePlayDefaults({}).backgroundTasks.styleReference, true)
  assert.equal(normalizePlayDefaults({ backgroundTasks: { styleReference: false } }).backgroundTasks.styleReference, false)
  assert.equal(normalizeBackgroundTasks({}).styleReference, false)
  assert.equal(normalizeBackgroundTasks({ styleReference: true }).styleReference, true)
  assert.equal(styleReferenceFor({ messages: [{ role: 'assistant', turn: 1 }], styleReferences: [ref(1)] }), null)
  assert.equal(latestStyleReference({ styleReferences: [ref(1)] }), null)
})

test('每轮用前一条回复之后摘的参考；重新生成时旧回复已撤下，仍用前一条回复的参考', () => {
  const chat = turns => ({ backgroundTasks: { styleReference: true }, styleReferences: [ref(1, '边城'), ref(2, '呼兰河传')],
    messages: turns.flatMap(turn => [{ role: 'user', text: '…' }, { role: 'assistant', turn }]).concat([{ role: 'user', text: '本轮输入' }]) })
  assert.equal(styleReferenceFor(chat([1, 2])).book, '呼兰河传')
  // Regenerating the turn after reply 1: reply 2 is rolled back, and the regenerated turn gets a new native number.
  assert.equal(styleReferenceFor(chat([1])).book, '边城')
  assert.equal(styleReferenceFor(chat([1, 2, 5])), null, '没有为这条回复摘过参考就不带')
})

test('同一轮重摘会替换旧条目，并丢掉回滚后失效的后续条目', () => {
  const list = rememberStyleReference([ref(1), ref(2), ref(3)], { book: '围城', author: '钱锺书', quote: '婚姻是一座围城。' }, 2)
  assert.deepEqual(list.map(item => [item.afterTurn, item.book]), [[1, '边城'], [2, '围城']])
  assert.equal(rememberStyleReference(Array.from({ length: 12 }, (_, i) => ref(i)), ref(20), 20).length, 8)
})

test('提交内容要有不超过 400 字的范文，书名、作者可不填', () => {
  assert.deepEqual(readStyleReference({ book: '《边城》', author: '沈从文', quote: ' 小溪流下去。 ' }), { book: '边城', author: '沈从文', quote: '小溪流下去。' })
  assert.deepEqual(readStyleReference({ quote: '句子' }), { book: '', author: '', quote: '句子' })
  assert.throws(() => readStyleReference({ book: '边城', author: '沈从文', quote: ' ' }))
  assert.throws(() => readStyleReference({ book: '边城', author: '沈从文', quote: '长'.repeat(401) }))
})

test('后台回忆提交后写入本局，供下一轮使用', async () => {
  let saved
  const taskRun = {
    participantRequest: { sessionId: 'bg', rewindTo: null, formatVersion: 1 },
    bindSession() {}, participant: run => run,
    async commit({ apply }) { saved = {}; apply(saved); return { status: 'committed' } },
    async fail() { throw new Error('不应失败') }
  }
  let request
  const recall = createStyleReferenceRecall({
    selection: () => ({ provider: 'p', model: 'm' }),
    beginTask: async () => taskRun,
    runAgent: async input => {
      request = input
      input.onToolCall({ name: 'style_reference_submit', arguments: JSON.stringify({ book: '边城', author: '沈从文', quote: '小溪流下去，绕山岨流。' }) })
      return { traceSessionId: 'bg' }
    }
  })
  const chat = { sessionId: 's', messages: [{ role: 'user', text: '走吧' }, { role: 'assistant', turn: 4, sourceText: '雨落在河面上。\n<details><summary>人物状态</summary>' + '视线：窗外。'.repeat(1000) + '<details><summary>物品</summary>库存</details></details><状态栏>心情：平静</状态栏>' }] }
  const result = await recall({ chat, signal: new AbortController().signal })
  assert.equal(result.book, '边城')
  assert.equal(request.task, 'style-reference')
  assert.match(request.messages[0].content[0].text, /雨落在河面上/)
  assert.doesNotMatch(request.messages[0].content[0].text, /视线|库存|心情|details|状态栏/)
  assert.deepEqual(saved.styleReferences, [{ book: '边城', author: '沈从文', quote: '小溪流下去，绕山岨流。', afterTurn: 4 }])
})

test('正文上下文带上文风联想与借鉴规则', async () => {
  const planner = createContextPlanner({ prompt: name => '〈' + name + '〉' })
  const plan = await planner.plan({ purpose: 'body', card: { name: '阿青' }, chat: {}, worldBookContext: '',
    styleReference: { book: '边城', author: '沈从文', quote: '小溪流下去。' } })
  const style = plan.sections.filter(section => section.kind === 'style-reference').map(section => section.text)
  assert.deepEqual(style, ['【文风联想 · 《边城》沈从文】\n小溪流下去。', '〈style-reference〉'])
  const without = await planner.plan({ purpose: 'body', card: { name: '阿青' }, chat: {}, worldBookContext: '', styleReference: null })
  assert.equal(without.sections.some(section => section.kind === 'style-reference'), false)
})

test('换一段：按玩家要求重摘，并告诉模型上次选了什么；重新生成时按前一条回复重摘', async () => {
  const saved = { styleReferences: [ref(3, '边城'), ref(5, '药')] }
  const taskRun = { participantRequest: { sessionId: 'bg', rewindTo: null, formatVersion: 1 }, bindSession() {}, participant: run => run,
    async commit({ apply }) { apply(saved); return { status: 'committed' } }, async fail() { throw new Error('不应失败') } }
  const requests = []
  const recall = createStyleReferenceRecall({ selection: () => null, beginTask: async () => taskRun,
    runAgent: async input => { requests.push(input); input.onToolCall({ name: 'style_reference_submit', arguments: { book: '射雕英雄传', author: '金庸', quote: '郭靖一掌拍出。' } }); return {} } })
  const chat = { sessionId: 's', styleReferences: saved.styleReferences, messages: [{ role: 'assistant', turn: 3, text: '甲' }, { role: 'user', text: '乙' }, { role: 'assistant', turn: 5, text: '丙' }] }
  await recall({ chat, signal: new AbortController().signal, base: 'previous', guidance: '要金庸的打斗描写', retry: true })
  const text = requests[0].messages[0].content[0].text
  assert.match(text, /甲/)
  assert.match(text, /上一次选的是《边城》沈从文/)
  assert.match(text, /要金庸的打斗描写/)
  assert.deepEqual(saved.styleReferences.map(item => [item.afterTurn, item.book]), [[3, '射雕英雄传']], '被重写那一轮之后的参考一并失效')
  await assert.rejects(recall({ chat: { ...chat, messages: [{ role: 'assistant', turn: 1, greeting: true }] }, signal: new AbortController().signal, base: 'previous', retry: true }), /之前没有可依据的回复/)
})

test('选段提示词来自系统提示词「文风联想选段」：按题材选书，不限名家', async () => {
  const { prompt, SYSTEM_PROMPT_NAMES } = await import('../tavern-plugin/lib/prompt-catalog.js')
  assert.ok(SYSTEM_PROMPT_NAMES.includes('style-reference-recall'))
  assert.match(prompt('style-reference-recall'), /轻小说/)
  let system
  const recall = createStyleReferenceRecall({ selection: () => null, systemPrompt: () => '自定义选段要求',
    beginTask: async () => ({ participantRequest: {}, participant: () => null, bindSession: async () => {}, commit: async () => ({ status: 'committed' }), fail: async () => {} }),
    runAgent: async input => { system = input.system; input.onToolCall({ name: 'style_reference_submit', arguments: { book: '书', author: '作者', quote: '一段' } }); return {} } })
  await recall({ chat: { sessionId: 's', messages: [{ role: 'assistant', turn: 2, text: '正文' }] } })
  assert.equal(system, '自定义选段要求')
})


test('文风正文保留普通折叠剧情、首尾和空内容兜底', () => {
  const prose = '开场。<details><summary>回忆</summary>“那年下着雨。”</details>结尾。'
  assert.equal(styleReferenceReplyText(prose + '<状态栏>心情</状态栏>'), prose)
  assert.equal(styleReferenceReplyText('<details><summary>正文</summary>故事</details>'), '<details><summary>正文</summary>故事</details>')
  assert.equal(styleReferenceReplyText(''), '')
  assert.equal(styleReferenceReplyText('<状态栏>只有状态</状态栏>'), '<状态栏>只有状态</状态栏>')
  assert.equal(styleReferenceReplyText('正文<UpdateVariable>patch</UpdateVariable><visual_cards>panel</visual_cards><StatusPlaceHolderImpl/>'), '正文')
  const long = styleReferenceReplyText('开场' + '文'.repeat(7000) + '结尾')
  assert.equal(long.length, 6000)
  assert.ok(long.startsWith('开场') && long.endsWith('结尾'))
})


test('foreground style reference shares this turn, persists for inspection and never concludes the writer', async () => {
  const { createForegroundStyleReferenceTool, foregroundStyleReferencePrompt } = await import('../tavern-plugin/lib/domain/style-reference.js')
  let chat = { id: 'chat', sessionId: 'game', mode: 'story', backgroundTasks: { styleReference: true } }, saved = []
  const tool = createForegroundStyleReferenceTool({ chatForSession: async () => chat, isBackground: id => id === 'background',
    save: async (...args) => saved.push(args) })
  const exec = { agent: { session: { id: 'game', events: [{ type: 'turn/start', data: { turn: 8 } }] } }, concludeTurn() { assert.fail('association must not end writing') } }
  const result = JSON.parse(await tool.execute({ quote: '雨落在青石上。' }, exec))
  assert.equal(result.ok, true)
  assert.match(result.next, /继续/)
  assert.equal(saved[0][2], 8)
  const fixed = foregroundStyleReferencePrompt(chat, '选段要求', '写作要求')
  assert.match(fixed, /前台文风联想/)
  assert.equal(foregroundStyleReferencePrompt({ ...chat, styleReferences: [ref(8)] }, '选段要求', '写作要求'), fixed, 'new references do not mutate the fixed prefix')
  await assert.rejects(tool.execute({ quote: 'x'.repeat(401) }, exec), /400/)
  chat.backgroundTasks.styleReference = false
  assert.equal(foregroundStyleReferencePrompt(chat, '选段要求', '写作要求'), '')
  await assert.rejects(tool.execute({ quote: '参考' }, exec), /未开启/)
  chat.backgroundTasks.styleReference = true
  chat.disabledForegroundTools = ['style_reference_submit']
  await assert.rejects(tool.execute({ quote: '参考' }, exec), /未开启/)
  delete chat.disabledForegroundTools
  await assert.rejects(tool.execute({ quote: '参考' }, { agent: { session: { ...exec.agent.session, id: 'background' } } }), /前台/)
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(tool.execute({ quote: '参考' }, { ...exec, signal: cancelled.signal }))
  assert.equal(saved.length, 1, 'rejected or cancelled calls never persist a reference')
})
