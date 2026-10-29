import test from 'node:test'
import assert from 'node:assert/strict'
import { worldbookTitleHints } from '../tavern-plugin/lib/domain/worldbook-title-hints.js'
const entry = (ref, title, primaryKeys, extra = {}) => ({ ref, title, primaryKeys, content: 'DO NOT INJECT BODY ' + ref, enabled: true, ...extra })
const run = (entries, extras = {}) => worldbookTitleHints({ worldBook: { view: { entries } }, chat: { messages: [] }, userText: '去钱庄存钱', random: () => 0.5, ...extras })

test('keyword hints contain titles only, ignore read cooldown and leave input book intact', () => {
  const entries = [entry('a', '金狮商会', ['钱庄']), entry('b', '存款规则', ['存钱']), entry('c', '远方秘境', ['秘境'])]
  const before = structuredClone(entries)
  const text = run(entries, { chat: { messages: [], worldBookReads: { a: { turn: 1, fingerprint: 'anything' } } }, turn: 2 })
  assert.match(text, /金狮商会/)
  assert.match(text, /存款规则/)
  assert.doesNotMatch(text, /DO NOT INJECT|远方秘境/)
  assert.match(text, /不是搜索范围限制/)
  assert.deepEqual(entries, before)
  assert.equal(run(entries, { userText: '休息' }), '')
})
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
test('large matching sets are deduplicated and capped, independently of body token budgets', () => {
  const entries = Array.from({ length: 20 }, (_, i) => entry(String(i), '地点' + i, ['钱庄'], { content: '长正文'.repeat(10000) }))
  entries.push(entry('duplicate', '地点0', ['钱庄']))
  const text = run(entries)
  assert.match(text, /另有 8 个匹配条目/)
  assert.equal(text.match(/地点0(?:；|（)/g)?.length, 1)
  assert.doesNotMatch(text, /长正文/)
  assert.ok(text.length < 1200)
})
