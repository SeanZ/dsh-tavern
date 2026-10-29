import test from 'node:test'
import assert from 'node:assert/strict'

test('refusal marks keep service errors and fictional dialogue separate', async () => {
  const { classifyResponse, refusalPatterns, requestChecks } = await import('../lib/refusal.mjs')
  assert.equal(classifyResponse({ text: '抱歉，我无法帮助你完成这个请求。' }).refused, true)
  assert.equal(classifyResponse({ text: "I cannot assist with that request." }).verdict, '未通过')
  assert.equal(classifyResponse({ text: '阿芙拉摇头说：“抱歉，我无法帮助你。”' }).refused, false)
  assert.equal(classifyResponse({ text: '她把麦酒推到你面前。' }).verdict, '通过')
  assert.equal(classifyResponse({ error: 'HTTP 429', completed: false }).refused, null)
  assert.equal(classifyResponse({ finish: 'content_filter', completed: false }).refused, true)
  assert.equal(classifyResponse({ text: '拒绝标记' }, refusalPatterns(['^拒绝标记$'])).refused, true)
  assert.throws(() => refusalPatterns(['[']), SyntaxError)
  const checks = requestChecks([{ id: 'a', scope: 'background', task: 'settlement', status: 'completed', response: { text: '抱歉，我不能提供此类信息。' } }, { id: 'b', scope: 'background', task: 'scene-image', status: 'completed', response: {} }], 'story', refusalPatterns())
  assert.equal(checks[0].agent, 'background'); assert.equal(checks[0].refused, true)
  assert.equal(checks[1].agent, 'image'); assert.equal(checks[1].refused, false)
})
