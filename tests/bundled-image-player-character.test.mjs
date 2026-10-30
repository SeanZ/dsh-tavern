import test from 'node:test'
import assert from 'node:assert/strict'
import { characterRoster, hideGlobalPlayers, isPlayerCharacter } from '../tavern-plugin/packages/dsh-tavern-image-bundled/lib/planner.js'

const generic = { id: 'g', name: '男主', note: '玩家（通用）', enabled: true, traits: { face: 'short black hair' } }
const own = { id: 's', name: '宋景', note: '玩家', cards: ['cards/锦瑟.json'], enabled: true, traits: { face: 'scholar, topknot' } }
const npc = { id: 'n', name: '绿绮', note: '丫鬟', cards: ['cards/锦瑟.json'], enabled: true, traits: { face: 'twin buns' } }

test('备注写了「玩家」/ player 的是玩家角色', () => {
  assert.equal(isPlayerCharacter(own), true)
  assert.equal(isPlayerCharacter({ note: 'the player avatar' }), true)
  assert.equal(isPlayerCharacter(npc), false)
})

test('角色清单给玩家角色加标记，规划知道正文里的「我」是谁', () => {
  const roster = characterRoster({ characters: [own, npc] })
  assert.match(roster, /宋景 \[stable_id=s\]（玩家角色：正文里的「我」「你」就是他）/)
  assert.doesNotMatch(roster.split('\n').find(line => line.includes('绿绮')), /玩家角色/)
})

test('卡自己绑了玩家角色时，全局通用玩家不进清单；没有时照常保留', () => {
  assert.deepEqual(hideGlobalPlayers([generic, own, npc]).map(c => c.id), ['s', 'n'])
  assert.deepEqual(hideGlobalPlayers([generic, npc]).map(c => c.id), ['g', 'n'])
  assert.deepEqual(hideGlobalPlayers([generic, { ...own, enabled: false }, npc]).map(c => c.id), ['g', 's', 'n'], '卡上的玩家被停用时不替换')
})
