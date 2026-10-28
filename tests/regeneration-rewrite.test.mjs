import assert from 'node:assert/strict'
import test from 'node:test'

import { attemptStreamText, regenerationInputText } from '../tavern-plugin/lib/domain/round-history.js'
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



test('被中断的重新生成从 assistant/attempt 的 chunk 里取回正文', () => {
  const attempt = (seq, turn, stream) => ({ seq, type: 'assistant/attempt', data: { turn, step: 1, stream } })
  const events = [
    // A previous, committed round of the same chat: never this attempt's text.
    { seq: 1, type: 'assistant/message', data: { turn: 5, step: 1, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '旧正文' }] } } },
    attempt(9, 6, [
      { type: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
      { type: 'chunk', chunk: { type: 'reasoning-delta', index: 0, text: '先想一想' } },
      { type: 'chunk', chunk: { type: 'block-start', index: 1, blockType: 'text' } },
      // v4 压缩后的增量批次，以及收尾时的 block-end 全文。
      { type: 'text-chunks', index: 1, dt: [10, 20], texts: ['她推开', '门，'] },
      { type: 'chunk', chunk: { type: 'block-end', index: 1, block: { type: 'text', text: '她推开门，雨声灌了进来。' } } },
      { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'Provider finish_reason: error' } } } }
    ])
  ]
  // 刚好在尝试开始时截断的正文属于这一轮；reasoning 不算正文。
  assert.equal(attemptStreamText(events, 9, 6), '她推开门，雨声灌了进来。')
  // 宿主没把回合号推进时，按回合号找不到就退回"这次尝试之后的最后一条流"（turn 传 0）。
  assert.equal(attemptStreamText(events, 9, 5), '')
  assert.equal(attemptStreamText(events, 9, 0), '她推开门，雨声灌了进来。')
  // 没有这次尝试的流就是没有正文，绝不拿别的回合顶替。
  assert.equal(attemptStreamText(events, 2, 5), '')
  // 只有 reasoning 的流不能当正文保存。
  assert.equal(attemptStreamText([attempt(3, 7, [{ type: 'chunk', chunk: { type: 'reasoning-delta', index: 0, text: '想一想' } }])], 3, 7), '')
})
