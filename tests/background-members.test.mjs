import assert from 'node:assert/strict'
import test from 'node:test'

import { BACKGROUND_MEMBERS, memberOf, participantOf, slotOf, memberName } from '../tavern-plugin/lib/domain/background-members.js'

test('任务按成员归属：书记沿用每局原有的后台会话，旧存档的角色也归它', () => {
  for (const role of ['settlement', 'ledger', 'candidate', 'character-design', 'worldbook-filter', 'style-reference']) {
    assert.equal(memberOf(role), 'background', role)
    assert.equal(participantOf(role), 'background', role)
  }
  assert.equal(memberOf('polish'), 'polish')
  assert.equal(memberName('background'), '书记')
  assert.deepEqual(BACKGROUND_MEMBERS.map(member => member.id), ['background', 'polish'])
})

test('临时任务没有成员；插件任务没有常驻会话，但排在书记的锁上', () => {
  for (const role of ['stage-director', 'phone', 'plugin', 'plugin-task']) assert.equal(memberOf(role), '', role)
  assert.equal(participantOf('plugin-task'), 'plugin-task')
  assert.equal(slotOf('plugin-task'), 'background')
  assert.equal(slotOf('stage-director'), 'stage-director')
})
