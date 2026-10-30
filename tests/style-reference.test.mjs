import assert from 'node:assert/strict'
import test from 'node:test'


const ref = (afterTurn, book = '边城') => ({ book, author: '沈从文', quote: '小溪流下去，绕山岨流。', afterTurn })

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
