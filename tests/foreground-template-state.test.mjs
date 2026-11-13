import test from 'node:test'
import assert from 'node:assert/strict'
import { inputTemplateDigest, mergeInputTemplateData, preparationMessageContent } from '../tavern-plugin/lib/domain/foreground-template-state.js'

test('模板差量采用最新已提交字段，保留其它插件数据与未变的准备结果', () => {
  const before = { tavernPluginData: { is_ejs_processed: [false], variables_initialized: false } }
  const prepared = { text: '输入', tavernPluginData: { is_ejs_processed: [false], variables_initialized: true, own: 1 } }
  const latest = { tavernPluginData: { is_ejs_processed: [true], variables_initialized: false, other: 2 } }
  const next = mergeInputTemplateData(prepared, latest, inputTemplateDigest(before))
  assert.deepEqual(next.tavernPluginData, { is_ejs_processed: [true], variables_initialized: true, own: 1, other: 2 })
  assert.deepEqual(prepared.tavernPluginData.is_ejs_processed, [false])
})

test('模板字段已删除时不被旧准备结果复活', () => {
  const before = { tavernPluginData: { template_rendered: { hash: 'old' } } }
  assert.deepEqual(mergeInputTemplateData(before, {}, inputTemplateDigest(before)), {})
})

test('模板标记可并发更新，正文、候选和其它插件数据仍受保护', () => {
  const row = { text: '输入', swipeId: 0, swipes: ['输入'] }
  assert.deepEqual(preparationMessageContent({ ...row, tavernPluginData: { is_ejs_processed: [true] } }), row)
  for (const patch of [{ text: '不同' }, { swipeId: 1 }, { swipes: ['不同'] }, { tavernPluginData: { custom: true } }]) {
    assert.notDeepEqual(preparationMessageContent({ ...row, ...patch }), row)
  }
})
