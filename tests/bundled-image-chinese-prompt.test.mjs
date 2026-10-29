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
