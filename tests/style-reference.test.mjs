import assert from 'node:assert/strict'
import test from 'node:test'

import { latestStyleReference, readStyleReference, rememberStyleReference } from '../tavern-plugin/lib/domain/style-reference.js'
import { createContextPlanner } from '../tavern-plugin/lib/domain/context-planner.js'
import { normalizeBackgroundTasks, normalizePlayDefaults } from '../tavern-plugin/lib/domain/tavern-settings.js'

const ref = (afterTurn, book = '边城') => ({ book, author: '沈从文', quote: '小溪流下去，绕山岨流。', afterTurn })

test('新游戏默认开启文风联想（全局默认可关）；没有这项的旧存档保持关闭', () => {
  assert.equal(normalizePlayDefaults({}).backgroundTasks.styleReference, true)
  assert.equal(normalizePlayDefaults({ backgroundTasks: { styleReference: false } }).backgroundTasks.styleReference, false)
  assert.equal(normalizeBackgroundTasks({}).styleReference, false)
  assert.equal(normalizeBackgroundTasks({ styleReference: true }).styleReference, true)
  assert.equal(latestStyleReference({ styleReferences: [ref(1)] }), null)
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

test('正文上下文带上文风联想与借鉴规则', async () => {
  const planner = createContextPlanner({ prompt: name => '〈' + name + '〉' })
  const plan = await planner.plan({ purpose: 'body', card: { name: '阿青' }, chat: {}, worldBookContext: '',
    styleReference: { book: '边城', author: '沈从文', quote: '小溪流下去。' } })
  const style = plan.sections.filter(section => section.kind === 'style-reference').map(section => section.text)
  assert.deepEqual(style, ['【文风联想 · 《边城》沈从文】\n小溪流下去。', '〈style-reference〉'])
  const without = await planner.plan({ purpose: 'body', card: { name: '阿青' }, chat: {}, worldBookContext: '', styleReference: null })
  assert.equal(without.sections.some(section => section.kind === 'style-reference'), false)
})

test('选段提示词来自系统提示词「文风联想选段」：按题材选书，不限名家', async () => {
  const { prompt, SYSTEM_PROMPT_NAMES } = await import('../tavern-plugin/lib/prompt-catalog.js')
  assert.ok(SYSTEM_PROMPT_NAMES.includes('style-reference-recall'))
  assert.match(prompt('style-reference-recall'), /轻小说/)
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
  // A per-game tool blacklist left in an old save is ignored since bd0c590e.
  chat.disabledForegroundTools = ['style_reference_submit']
  assert.equal(JSON.parse(await tool.execute({ quote: '参考' }, exec)).ok, true)
  delete chat.disabledForegroundTools
  await assert.rejects(tool.execute({ quote: '参考' }, { agent: { session: { ...exec.agent.session, id: 'background' } } }), /前台/)
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(tool.execute({ quote: '参考' }, { ...exec, signal: cancelled.signal }))
  assert.equal(saved.length, 2, 'rejected or cancelled calls never persist a reference')
})
