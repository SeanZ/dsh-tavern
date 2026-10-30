import test from 'node:test'
import assert from 'node:assert/strict'
import { expandRosterCalls, repairMacros } from '../tavern-plugin/packages/dsh-tavern-image-bundled/lib/index.js'

const ru = {
  id: 'r', name: '柳如是', match: 'Liu Rushi', enabled: true,
  traits: { face: 'long black hair, almond eyes' },
  outfits: [
    { id: 'o1', name: '常服', upper: 'pale blue robe', lower: 'white skirt', shoes: 'cloth shoes', default: true },
    { id: 'o2', name: '日常襦裙（女装·常服）', upper: 'light green ruqun top', lower: 'light green long skirt' },
  ],
}
const defs = { characters: [ru] }

test('漏了结尾 $、只写了 { … } 的人物宏会被补全', () => {
  assert.equal(repairMacros('${"name":"Liu Rushi","angle":"from front"}, 她站在廊下'), '${"name":"Liu Rushi","angle":"from front"}$, 她站在廊下')
  assert.equal(repairMacros('{"name":"Liu Rushi","angle":"from front"}, 她站在廊下'), '${"name":"Liu Rushi","angle":"from front"}$, 她站在廊下')
  const ok = '${"name":"Liu Rushi"}$, 她站在廊下'
  assert.equal(repairMacros(ok), ok, '完整的宏不动')
})

test('坏宏不会吞掉后面的画面描述和下一个宏', () => {
  const raw = '${"name":"Liu Rushi","angle":"from front"}, 她提着灯笼，${"name":"Liu Rushi","angle":"from side"}$'
  const out = expandRosterCalls(raw, defs, 'natural', { style: 'tags' })
  assert.match(out, /她提着灯笼/)
  assert.doesNotMatch(out, /"name"/)
  assert.equal(out.match(/long black hair/g)?.length, 2)
})

test('「服装名（状态）」：认出服装库里的那套，括号里的状态接在后面', () => {
  const raw = '${"name":"Liu Rushi","upperBody":"sfw","lowerBody":"sfw","outfit":"常服（袖口挽起）"}$'
  const out = expandRosterCalls(raw, defs, 'natural', { style: 'tags' })
  assert.match(out, /pale blue robe/)
  assert.match(out, /袖口挽起/)
})

test('服装名本身带括号、规划漏写或把状态塞进同一个括号：照样认出', () => {
  const missing = expandRosterCalls('${"name":"Liu Rushi","upperBody":"sfw","lowerBody":"sfw","outfit":"日常襦裙"}$', defs, 'natural', { style: 'tags' })
  assert.match(missing, /light green ruqun top/)
  const merged = expandRosterCalls('${"name":"Liu Rushi","upperBody":"sfw","lowerBody":"sfw","outfit":"日常襦裙（女装·常服，袖口沾墨）"}$', defs, 'natural', { style: 'tags' })
  assert.match(merged, /light green ruqun top/)
  assert.match(merged, /袖口沾墨/)
  assert.doesNotMatch(merged, /女装·常服/)
})

test('同一角色的两个形态（名字只差括号后缀）：宏写本名时按画面线索挑形态', () => {
  const human = { id: 'h', name: '殷雪（人形）', match: 'Yin Xue', enabled: true, traits: { face: 'black hair, human ears' }, outfits: [] }
  const fox = { id: 'f', name: '殷雪（显形）', match: 'Yin Xue', enabled: true, formCues: 'fox ears, 狐尾', traits: { face: 'silver hair, fox ears' }, outfits: [] }
  const forms = { characters: [human, fox] }
  const plain = expandRosterCalls('${"name":"Yin Xue","angle":"from front"}$, 她在窗边', forms, 'natural', { style: 'tags' })
  assert.match(plain, /human ears/)
  const tail = expandRosterCalls('${"name":"Yin Xue","angle":"from front"}$, 她身后的狐尾轻轻摆着', forms, 'natural', { style: 'tags' })
  assert.match(tail, /silver hair/)
})
