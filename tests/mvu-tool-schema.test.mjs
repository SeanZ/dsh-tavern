import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeMvuToolSubmission } from "../tavern-plugin/lib/domain/mvu-background-settlement.js"

test('invalid or ambiguous encoded values fail before dispatch; legacy persisted operations survive', () => {
  for (const extra of [{ valueJson: '{' }, { valueJson: false }, { valueJson: '1', value: false }, { valueJson: '1e999' }]) {
    assert.throws(() => normalizeMvuToolSubmission({ operations: [{ op: 'replace', path: '/hp', ...extra }] }))
  }
  assert.throws(() => normalizeMvuToolSubmission({ operations: [{ op: 'delta', path: '/hp', valueJson: 'false' }] }))
  const operations = [{ op: 'replace', path: '/hp', value: 3 }, { op: 'remove', path: '/old' }, { op: 'move', from: '/a', path: '/b' }]
  assert.deepEqual(normalizeMvuToolSubmission({ operations }).operations, operations)
})

test('文本值忘了加 JSON 双引号时按文本收下；像对象、列表、数字或带引号却写坏的值仍退回重写', () => {
  const one = valueJson => normalizeMvuToolSubmission({ operations: [{ op: 'replace', path: '/stat_data/铃/心态', valueJson }] }).operations[0].value
  assert.equal(one('得意'), '得意')
  assert.equal(one('  嘴硬勒索、半推半就地配合 '), '嘴硬勒索、半推半就地配合')
  assert.equal(one('"城市街道"'), '城市街道')
  for (const broken of ['{"名称": 1', '[1, 2', '"没有闭合', '50（提升）', '-3点', '']) {
    assert.throws(() => one(broken), /valueJson 不是有效 JSON/, broken)
  }
  // A delta still needs a number.
  assert.throws(() => normalizeMvuToolSubmission({ operations: [{ op: 'delta', path: '/hp', valueJson: '很多' }] }), /delta/)
})
