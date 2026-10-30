import test from 'node:test'
import assert from 'node:assert/strict'
import { expandRosterCalls, footwearOverridden, injectDefinitions } from '../tavern-plugin/packages/dsh-tavern-image-bundled/lib/index.js'

const jing = {
  id: 'j', name: '许静好', match: 'Xu Jinghao', enabled: true,
  traits: { face: 'short brown hair, freckles' },
  outfits: [
    { id: 'o1', name: '格子衬衫牛仔裤', upper: 'red plaid shirt', lower: 'blue jeans', shoes: 'white sneakers, white ankle socks', default: true },
    { id: 'o2', name: '野球球衣短裤', upper: 'blue jersey', lower: 'black shorts', shoes: 'black football boots, white knee socks' },
  ],
}
const defs = { characters: [jing] }

test('画面写了另一种鞋（中文鞋名不在这身衣服里）：服装里的鞋不再写进去', () => {
  assert.equal(footwearOverridden('右脚踩进黑色足球鞋里，左脚还穿着自己的鞋', '脚上穿着白色运动鞋'), true)
  assert.equal(footwearOverridden('她站在门口看手机', '脚上穿着白色运动鞋'), false)
  assert.equal(footwearOverridden('白运动鞋在薄雪上踩出脚印', '脚上穿着白色运动鞋'), false, '写的就是这双鞋时照常')
})

test('脱鞋、换拖鞋、只穿袜子：服装里的鞋去掉，袜子保留', () => {
  for (const scene of ['她在玄关脱了鞋', '她换上拖鞋走进客厅', '她只穿着袜子站在地板上', 'standing in her socks']) {
    assert.equal(footwearOverridden(scene, 'white sneakers'), true, scene)
  }
  const raw = '${"name":"Xu Jinghao","angle":"from front","upperBody":"sfw","lowerBody":"sfw"}$, 她换上拖鞋站在玄关'
  const out = expandRosterCalls(raw, defs, 'natural', { style: 'tags' })
  assert.doesNotMatch(out, /white sneakers/)
  assert.match(out, /white ankle socks/)
})

test('中文赤脚和英文 barefoot 一样，鞋袜都不写', () => {
  const raw = '${"name":"Xu Jinghao","angle":"from front","upperBody":"sfw","lowerBody":"sfw"}$, 她光着脚坐在床边'
  const out = expandRosterCalls(raw, defs, 'natural', { style: 'tags' })
  assert.doesNotMatch(out, /sneakers|socks/)
  assert.match(out, /blue jeans/)
})

test('画面没提鞋：照常带服装库里的鞋', () => {
  const raw = '${"name":"Xu Jinghao","angle":"from front","upperBody":"sfw","lowerBody":"sfw"}$, 她站在街边'
  assert.match(expandRosterCalls(raw, defs, 'natural', { style: 'tags' }), /white sneakers/)
})

test('按名字注入（没用人物宏）时同样认中文换鞋', () => {
  const raw = '1girl, Xu Jinghao, 她坐在凳子上换上足球鞋'
  const { text } = injectDefinitions(raw, defs, {}, { raw })
  assert.doesNotMatch(text, /white sneakers/)
  assert.match(text, /red plaid shirt/)
})

test('鞋拿在手里时不算赤脚，也不往负面里加 shoes', () => {
  const raw = '1girl, Xu Jinghao, 光脚站着，手里拎着鞋'
  const { negative = '' } = injectDefinitions(raw, defs, {}, { raw })
  assert.doesNotMatch(String(negative), /\bshoes\b/)
})
