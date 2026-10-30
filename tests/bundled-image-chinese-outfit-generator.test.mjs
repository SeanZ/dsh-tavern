import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOutfitPrompt, mergeOutfits, parseOutfits } from '../tavern-plugin/packages/dsh-tavern-image-bundled/lib/outfit-generator.js'

const zh = { name: '柳如是', traits: { face: '她是一位二十岁的年轻女子，鹅蛋脸', bodySFW: '身形纤细' },
  outfits: [{ name: '常服', upper: '上身穿着一件淡蓝色丝绸交领上襦', lower: '下身是一条白色长裙', shoes: '脚上穿着绣鞋', enabled: true }] }
const en = { name: 'Lily', traits: { face: 'long black hair', bodySFW: 'slim' }, outfits: [] }

test('人物外貌是中文：服装要求写中文整句，并以已有服装为风格参考', () => {
  const { system } = buildOutfitPrompt({ character: zh, count: 2 })
  assert.match(system, /全部用中文完整短句/)
  assert.match(system, /以「上身穿着」开头/)
  assert.match(system, /- 常服：上身穿着一件淡蓝色丝绸交领上襦/)
  assert.match(system, /不写开衩/)
})

test('人物外貌是英文 Tag：照旧要英文 Tag', () => {
  const { system } = buildOutfitPrompt({ character: en, count: 2 })
  assert.match(system, /上身英文 Tag/)
  assert.doesNotMatch(system, /全部用中文完整短句/)
})

test('服装名去掉空白和末尾的括号分类；合并时「常服」「常服（女装）」算同一套', () => {
  const { outfits } = parseOutfits('[{"name":"月白素纱 旗袍（女装·常服）","upper":"上身穿着一件月白色旗袍","lower":"下身是长下摆"}]')
  assert.equal(outfits[0].name, '月白素纱旗袍')
  const merged = mergeOutfits([{ name: '常服' }], [{ name: '常服（女装）', upper: 'x', lower: 'y' }, { name: '新衣', upper: 'x', lower: 'y' }])
  assert.equal(merged.added, 1)
  assert.equal(merged.skipped, 1)
})
