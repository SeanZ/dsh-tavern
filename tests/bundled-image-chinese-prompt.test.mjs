import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePrompts } from '../tavern-plugin/packages/dsh-tavern-image-bundled/lib/planner.js'

const zh = '侧面特写，她跪在石板上，口中含着他的肉棒，唾液顺着下巴滴落，upper body, night'

test('默认（开关关闭）：comfyui 后端仍按原规则清掉中文，行为不变', () => {
  const mixed = normalizePrompts('莉洁 kneeling on the floor', {}, { backend: 'comfyui', style: 'natural' })
  assert.equal(mixed.replace(/\s+/g, ' ').trim(), 'kneeling on the floor')
  // 整段中文被清空时照旧报错，提示改用英文（纯中文才会清空）
  assert.throws(
    () => normalizePrompts('侧面特写，她跪在石板上，唾液滴落', {}, { backend: 'comfyui', style: 'natural' }),
    /ComfyUI 提示词清理后为空/,
  )
})

test('开关打开：comfyui 后端保留中文长句，句尾英文 tag 也保留', () => {
  const out = normalizePrompts(zh, {}, { backend: 'comfyui', style: 'natural', allowChinese: true })
  assert.match(out, /侧面特写/)
  assert.match(out, /唾液顺着下巴滴落/)
  assert.match(out, /upper body/)
})

test('开关只影响这一处判定：非 comfyui 后端本来就不清中文', () => {
  const kept = normalizePrompts('莉洁 kneeling', {}, { backend: 'novelai', style: 'tags' })
  assert.match(kept, /莉洁/)
  const off = normalizePrompts('莉洁 kneeling', {}, { backend: 'novelai', style: 'tags', allowChinese: false })
  assert.match(off, /莉洁/, '开关为 false 也不该影响原本读中文的渠道')
})

test('开关打开后宏展开与空值兜底不受影响', () => {
  const out = normalizePrompts('${"name":"Lieze Moretti","angle":"from side"}$, 她跪在石板上', {}, { backend: 'comfyui', style: 'natural', allowChinese: true })
  assert.doesNotMatch(out, /\$\{/)
  assert.match(out, /Lieze Moretti/)
  assert.match(out, /她跪在石板上/)
})
