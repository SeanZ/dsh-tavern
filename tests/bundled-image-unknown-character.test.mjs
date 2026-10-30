import test from 'node:test'
import assert from 'node:assert/strict'
import { expandRosterCalls } from '../tavern-plugin/packages/dsh-tavern-image-bundled/lib/index.js'

const mei = { id: 'm', name: '阿梅', match: 'A Mei', enabled: true, traits: { face: 'MEI FACE' }, outfits: [] }
const run = (text, characters = [mei]) => expandRosterCalls(text, { characters }, 'auto')

test('人物库外的角色：赤脚画面去掉鞋，中文服装名与占位值不进提示词', () => {
  assert.doesNotMatch(run('${"name":"Lu Qi", "outfit":"green dress, cloth shoes"}$, barefoot, garden'), /shoes/)
  assert.equal(run('${"name":"Lu Qi", "outfit":"绿色襦裙"}$'), 'Lu Qi')
  assert.equal(run('${"name":"Lu Qi", "outfit":"none"}$'), 'Lu Qi')
  assert.equal(run('${"name":"xiao yu"}$'), 'xiao yu', '只有名字时保持原样')
})
