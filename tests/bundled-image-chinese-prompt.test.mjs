import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePrompts } from '../tavern-plugin/packages/dsh-tavern-image-bundled/lib/planner.js'

const zh = '侧面特写，她坐在石阶上，雨水顺着发梢滴落，upper body, night'

test('开关打开后宏展开与空值兜底不受影响', () => {
  const out = normalizePrompts('${"name":"Lieze Moretti","angle":"from side"}$, 她跪在石板上', {}, { backend: 'comfyui', style: 'natural', allowChinese: true })
  assert.doesNotMatch(out, /\$\{/)
  assert.match(out, /Lieze Moretti/)
  assert.match(out, /她跪在石板上/)
})

// The fork's explicit structured format and upstream's optional Chinese cleanup
// switch must remain independent after syncing upstream.
test('structured layout is preserved with either Chinese switch value', () => {
  const source = '【人物】\n林月，黑发。\n\n【约束】\n保留[参考图1]和 (记号:1.2)。'
  for (const backend of ['comfyui', 'atlascloud']) {
    for (const allowChinese of [false, true]) {
      assert.equal(normalizePrompts(source, {}, { backend, style: 'structured', allowChinese }), source)
    }
  }
})

test('non-structured Comfy prompts keep upstream opt-in Chinese behavior', () => {
  assert.doesNotMatch(normalizePrompts(zh, {}, { backend: 'comfyui', style: 'natural' }), /侧面/)
  assert.match(normalizePrompts(zh, {}, { backend: 'comfyui', style: 'natural', allowChinese: true }), /侧面/)
})
