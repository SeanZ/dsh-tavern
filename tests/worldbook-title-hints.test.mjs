import test from 'node:test'
import assert from 'node:assert/strict'
import { worldbookTitleHints } from '../tavern-plugin/lib/domain/worldbook-title-hints.js'
const entry = (ref, title, primaryKeys, extra = {}) => ({ ref, title, primaryKeys, content: 'DO NOT INJECT BODY ' + ref, enabled: true, ...extra })
const run = (entries, extras = {}) => worldbookTitleHints({ worldBook: { view: { entries } }, chat: { messages: [] }, userText: '去钱庄存钱', random: () => 0.5, ...extras })

test('original secondary-key and recent-history matching are reused, nonstatic entries excluded', () => {
  const entries = [
    entry('a', '存款规则', ['钱庄'], { secondaryKeys: ['存钱'], selective: true, selectiveLogic: 0 }),
    entry('b', '历史地点', ['码头']),
    entry('c', '常驻', ['钱庄'], { constant: true }),
    entry('d', '动态', ['钱庄'], { content: '<%= variable %>' }),
    entry('e', '禁用', ['钱庄'], { enabled: false }),
    entry('f', '[mvu_update]规则', ['钱庄'])
  ]
  const text = run(entries)
  assert.match(text, /存款规则/)
  assert.doesNotMatch(text, /历史地点|常驻|动态|禁用|mvu_update/)
  assert.equal(run([entries[0]], { userText: '去钱庄' }), '')
  assert.match(run(entries, { userText: '继续', chat: { messages: [{ role: 'assistant', text: '抵达码头' }] } }), /历史地点/)
})
