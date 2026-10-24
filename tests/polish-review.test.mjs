import assert from 'node:assert/strict'
import test from 'node:test'

import { applyPolishEdits, buildPolishReviewRequest, parsePolishReview, polishReviewContext } from '../tavern-plugin/lib/domain/polish-review.js'
import { prompt } from '../tavern-plugin/lib/prompt-catalog.js'

test('审稿读本轮玩家输入和上一轮正文', () => {
  const messages = [
    { role: 'assistant', greeting: true, text: '开场' },
    { role: 'user', text: '第一句' },
    { role: 'assistant', text: '上一轮', projectionText: '上一轮原文' },
    { role: 'user', text: '本轮输入' },
    { role: 'assistant', text: '本轮正文' }
  ]
  assert.deepEqual(polishReviewContext(messages), { input: '本轮输入', previous: '上一轮原文' })
  assert.deepEqual(polishReviewContext(messages.slice(0, 3)), { input: '第一句', previous: '开场' })
  // Only the latest floors are read for a long save; earlier floors are absent.
  const sparse = new Array(500)
  sparse.splice(496, 4, ...messages.slice(1))
  assert.deepEqual(polishReviewContext(sparse), { input: '本轮输入', previous: '上一轮原文' })
})

test('原则作 system，人物卡、前文与正文作审稿材料', () => {
  const request = buildPolishReviewRequest({ principles: prompt('polish'), card: { name: '罗峰', description: '少年武者' },
    playerName: '阿杰', input: '继续', previous: '上一轮', reply: '本轮正文' })
  assert.match(request.system, /修改清单/)
  const text = request.messages[0].content[0].text
  for (const part of ['【人物卡：罗峰】\n少年武者', '【玩家角色】阿杰', '【上一轮正文】\n上一轮', '【本轮玩家输入】\n继续', '【本轮正文】\n本轮正文']) assert.ok(text.includes(part), part)
  assert.throws(() => buildPolishReviewRequest({ principles: ' ', reply: 'x', input: '', previous: '' }), /精修原则为空/)
  assert.ok(!text.includes('【玩家的修改意见】'))
  const guided = buildPolishReviewRequest({ principles: prompt('polish'), input: '', previous: '', reply: '本轮正文', guidance: '侧重心理描写' })
  assert.match(guided.messages[0].content[0].text, /【玩家的修改意见】\n侧重心理描写/)
})

test('修改清单逐条定位原文，重叠的后一条不可选，读不懂的输出退回意见框', () => {
  const texts = ['他笑了。他笑了。', '指节泛白。她走了。\n\n雨停了。']
  const review = parsePolishReview('```json\n{"edits":[{"reason":"拖沓","find":"指节泛白。她走了。\\n\\n雨停了。","replace":"她走了。"},{"reason":"套话","find":"指节泛白。","replace":"x"},{"find":"他笑了。","replace":""},{"find":"没有这句","replace":"x"}]}\n```', texts)
  assert.deepEqual(review.edits.map(edit => edit.status), ['ok', 'overlap', 'ambiguous', 'missing'])
  assert.equal(review.edits[0].reason, '拖沓')
  assert.deepEqual(parsePolishReview('1. 这里写得拖', texts), { edits: [], fallback: '1. 这里写得拖' })
})

test('应用修改只替换选中的原句，原句不唯一或已不在就拒绝', () => {
  assert.deepEqual(applyPolishEdits(['甲。乙。', '丙。'], [{ find: '乙。', replace: '乙改。' }, { find: '丙。', replace: '' }]), ['甲。乙改。', ''])
  assert.throws(() => applyPolishEdits(['甲。甲。'], [{ find: '甲。', replace: 'x' }]), /找不到要改的原句/)
  assert.throws(() => applyPolishEdits(['甲。'], [{ find: '丁', replace: 'x' }]), /找不到要改的原句/)
})

test('精修对比按原文顺序切出未改与改动段，找不到或重叠的修改跳过', async () => {
  const { polishSegments } = await import('../tavern-plugin/lib/domain/polish-records.js')
  const segments = polishSegments('甲。乙。丙。', [{ find: '丙。', replace: '丙改。', reason: 'b' }, { find: '甲。', replace: '', reason: 'a' }, { find: '甲。乙', replace: 'x' }, { find: '丁', replace: 'y' }])
  assert.deepEqual(segments, [
    { kind: 'edit', n: 2, find: '甲。', replace: '', reason: 'a' },
    { kind: 'same', text: '乙。' },
    { kind: 'edit', n: 1, find: '丙。', replace: '丙改。', reason: 'b' }
  ])
})

test('只保留最近一次精修，那轮正文换了版本就不再显示、不能撤销', async () => {
  const { createPolishRecords } = await import('../tavern-plugin/lib/domain/polish-records.js')
  let game = null, key = 'k1'
  const records = createPolishRecords({
    data: { saveGame: async ({ data }) => { game = data }, readGame: async () => game },
    turns: { resolveGame: async () => ({ chatId: 'c', sessionId: 's' }), currentKey: async () => key },
    now: () => 5
  })
  await records.save('s', 3, { original: ['甲。乙。', '丙。'], edits: [{ find: '乙。', replace: '乙改。', reason: '套话' }], seconds: 20 })
  assert.deepEqual(await records.latest('s'), { turn: 3, at: 5, seconds: 20, count: 1, segments: [{ kind: 'same', text: '甲。' }, { kind: 'edit', n: 1, find: '乙。', replace: '乙改。', reason: '套话' }, { kind: 'same', text: '\n\n丙。' }] })
  assert.deepEqual((await records.current('s')).original, ['甲。乙。', '丙。'])
  key = 'k2'
  assert.equal(await records.latest('s'), null)
  assert.equal(await records.current('s'), null)
})
