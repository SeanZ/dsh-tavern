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

test('变量路径被写成网址编码（甚至编码两次）时还原成原文；解不开的照原样', () => {
  const path = pointer => normalizeMvuToolSubmission({ operations: [{ op: 'replace', path: pointer, valueJson: '"x"' }] }).operations[0].path
  assert.equal(path('/stat_data/%E9%93%83/%E5%BF%83%E6%80%81'), '/stat_data/铃/心态')
  assert.equal(path('/%25E5%259C%25BA%25E6%2599%25AF/%E5%9C%B0%E7%82%B9'), '/场景/地点')
  assert.equal(path('/stat_data/铃/心态'), '/stat_data/铃/心态')
  assert.equal(path('/stat_data/完成度100%'), '/stat_data/完成度100%')
  assert.equal(path('/stat_data/a~1b'), '/stat_data/a~1b', 'JSON Pointer escapes stay')
})
