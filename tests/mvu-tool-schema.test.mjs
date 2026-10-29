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

test('变量路径按当前变量里实际存在的键名解析：原样、解码一次、解码两次；新建的键用正常名字', async () => {
  const { resolveSubmissionPaths } = await import('../tavern-plugin/lib/domain/mvu-background-settlement.js')
  // A card whose own initial variables literally have the encoded key for 场景.
  const variables = { stat_data: { '%E5%9C%BA%E6%99%AF': { 地点: '办公室' }, 铃: { 心态: '得意' }, 进度: { '100%': 1 } } }
  const resolve = path => resolveSubmissionPaths({ operations: [{ op: 'replace', path, value: 'x' }] }, variables).operations[0].path
  assert.equal(resolve('/%E5%9C%BA%E6%99%AF/地点'), '/%E5%9C%BA%E6%99%AF/地点', 'the key as the card has it')
  assert.equal(resolve('/%25E5%259C%25BA%25E6%2599%25AF/地点'), '/%E5%9C%BA%E6%99%AF/地点', 'encoded once more by the model')
  assert.equal(resolve('/stat_data/%E9%93%83/%E5%BF%83%E6%80%81'), '/stat_data/铃/心态', 'a plain key the model encoded')
  assert.equal(resolve('/铃/心态'), '/铃/心态')
  assert.equal(resolve('/进度/100%'), '/进度/100%')
  assert.equal(resolve('/%E9%93%83/%E6%96%B0%E9%94%AE'), '/铃/新键', 'a new key gets its plain name')
  const moved = resolveSubmissionPaths({ operations: [{ op: 'move', from: '/%E9%93%83/%E5%BF%83%E6%80%81', path: '/铃/旧心态' }] }, variables).operations[0]
  assert.equal(moved.from, '/铃/心态')
})
