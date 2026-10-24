import assert from 'node:assert/strict'
import test from 'node:test'

import { regenerationInputText } from '../tavern-plugin/lib/domain/round-history.js'
import { projectRegenerationRequestMessages } from '../tavern-plugin/lib/domain/foreground-orchestration-strategies.js'

test('不填意见是重新来一次，不带旧正文', () => {
  assert.equal(regenerationInputText('继续', '', '旧正文'), '继续')
  // 找不到旧正文时，意见仍作为补充要求。
  assert.equal(regenerationInputText('继续', '写得更长', ''), '继续\n\n【本轮补充要求】\n写得更长')
})

test('填了意见就把当前正文放进本轮输入，作为要改的底稿', () => {
  const text = regenerationInputText('继续', '写得更长', '旧正文')
  assert.match(text, /^继续\n\n【当前正文】\n旧正文\n\n【改写要求】\n[^\n]*写得更长$/)
  // 没有意见就没有可改的方向，退回普通重新生成。
  assert.equal(regenerationInputText('继续', '', '旧正文'), '继续')
})

test('请求里旧回复照样被去掉，旧正文只经由改写输入出现一次', () => {
  const rewrite = regenerationInputText('继续', '写得更长', '旧正文')
  const messages = [
    { id: 'p1', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } },
    { role: 'assistant', content: [{ type: 'text', text: '旧正文' }], source: { kind: 'model' } },
    { role: 'user', content: [{ type: 'text', text: rewrite }], source: { kind: 'plugin:dsh-tavern-regen' } }
  ]
  const projected = projectRegenerationRequestMessages(messages)
  assert.equal(projected.length, 1)
  assert.equal(JSON.stringify(projected).split('旧正文').length - 1, 1)
})


