import test from 'node:test'
import assert from 'node:assert/strict'
import { hideGlobalPlayers, isPlayerCharacter } from '../tavern-plugin/packages/dsh-tavern-image-bundled/lib/planner.js'
import { resolveCharacterForms } from '../tavern-plugin/packages/dsh-tavern-image-bundled/lib/character-forms.js'

test('玩家备注只接受肯定标记，不把「不是玩家」或 non-player 当成玩家', () => {
  for (const note of ['玩家', 'player', '玩家本人', '玩家角色', '玩家（通用）', 'the player avatar', '身份：玩家']) {
    assert.equal(isPlayerCharacter({ note }), true, note)
  }

  for (const note of [
    '不是玩家', '非玩家角色', '不属于玩家', 'non-player character', 'NPC, not a player',
    '玩家的朋友', '向玩家出售物品', '备注提到 player',
  ]) {
    assert.equal(isPlayerCharacter({ note }), false, note)
  }
})

test('非玩家角色不会导致全局通用玩家从角色清单中隐藏', () => {
  const generic = { id: 'global-player', note: '玩家（通用）', cards: [] }
  const npc = { id: 'npc', note: 'non-player character', cards: ['card-1'] }
  assert.deepEqual(hideGlobalPlayers([generic, npc]).map(character => character.id), ['global-player', 'npc'])
})

test('中文否定形态线索不触发形态切换，肯定线索仍可切换', () => {
  const definitions = { characters: [
    { id: 'mei-human', name: '阿梅（人形）', match: '阿梅', formCues: '人形' },
    { id: 'mei-fox', name: '阿梅（狐形）', formCues: '狐耳, 狐尾' },
  ] }
  const macro = '${"name":"阿梅"}$'

  for (const denial of ['没有狐耳', '没有明显的狐耳', '不带狐尾', '无狐耳', '不是狐耳']) {
    assert.equal(resolveCharacterForms(`${macro} ${denial}`, definitions), macro + ` ${denial}`, denial)
  }
  assert.equal(resolveCharacterForms(`${macro} 她长出狐耳和狐尾`, definitions), '${"name":"阿梅（狐形）"}$ 她长出狐耳和狐尾')
  assert.equal(resolveCharacterForms(`${macro} no fox ears`, definitions), macro + ' no fox ears')
})
