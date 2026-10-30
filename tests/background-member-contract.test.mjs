import assert from 'node:assert/strict'
import test from 'node:test'

import { TIMELINE_MEMBERS, memberOf } from '../tavern-plugin/lib/domain/background-members.js'
import { referencedBackgroundSessionIds } from '../tavern-plugin/lib/domain/background-identity.js'
import { createBackgroundSessionRetirement } from '../tavern-plugin/lib/domain/background-session-retirement.js'
import { createAutoCompaction } from '../tavern-plugin/lib/domain/auto-compaction.js'
import { projectChatSessionState } from '../tavern-plugin/lib/domain/chat-session-state.js'
import { BACKGROUND_TASK_CATALOG } from '../tavern-plugin/lib/domain/background-tasks.js'

// The contract every member whose Session the save binds must keep. A member added to
// background-members.js is checked here without touching this file.
const ROLES = [...new Set(BACKGROUND_TASK_CATALOG.map(item => item.task).concat(['settlement', 'ledger', 'candidate', 'character-design']))]
const roleOf = member => ROLES.find(role => memberOf(role) === member)

test('每个绑定存档的成员都有任务归属', () => {
  assert.ok(TIMELINE_MEMBERS.includes('background'))
  for (const member of TIMELINE_MEMBERS) assert.ok(roleOf(member), member)
})

for (const member of TIMELINE_MEMBERS) {
  test(`成员 ${member}：用过的会话都算这局自己的后台会话`, () => {
    const chat = { timeline: {
      participants: { [member]: { sessionId: member + '-now' } },
      checkpoints: [{ participants: { [member]: { sessionId: member + '-checkpoint' } } }],
      operations: {
        done: { kind: 'agent', role: roleOf(member), status: 'completed', startedSessionId: member + '-started' },
        undo: { kind: 'body', beforeParticipants: { [member]: { sessionId: member + '-before' } } }
      }
    } }
    const ids = referencedBackgroundSessionIds(chat)
    for (const id of ['checkpoint', 'started', 'before']) assert.ok(ids.includes(member + '-' + id), id)
    // 书记's current Session is the game's backgroundSessionId; another member's is listed here.
    if (member !== 'background') assert.ok(ids.includes(member + '-now'))
  })

  test(`成员 ${member}：被新会话替下的失败会话会退休，当前会话不会`, async () => {
    const chat = { timeline: {
      participants: { [member]: { sessionId: 'current' } },
      operations: { old: { kind: 'agent', role: roleOf(member), status: 'failed', startedSessionId: 'replaced' } }
    } }
    const retirement = createBackgroundSessionRetirement({ readJson: async () => undefined }, { readState: async () => chat })
    const rows = ['replaced', 'current'].map(id => ({ kind: 'child', id, label: '酒馆后台 Agent', activity: 'inactive' }))
    assert.deepEqual((await retirement.filter(rows, 'game')).map(row => row.id), ['current'])
  })

  test(`成员 ${member}：上下文压缩时和前台一起压缩，并标记它的会话`, async () => {
    let chat = { id: 'chat', mode: 'story', sessionId: 'front', messages: [], timeline: { branchId: 'main',
      participants: Object.fromEntries(TIMELINE_MEMBERS.map(id => [id, { sessionId: id + '-session' }])) } }
    const compacted = [], marked = []
    const service = createAutoCompaction({
      readState: async () => projectChatSessionState(chat), readChat: async () => structuredClone(chat),
      updateChat: async (_id, fn) => { chat = fn(structuredClone(chat)); return structuredClone(chat) },
      policy: async () => ({ mode: 'manual' }), activity: () => ({ phase: 'idle' }), pressure: async () => null,
      exclusive: async (_id, fn) => fn(), checkpoint: async () => 1, recover: async () => 'succeeded',
      markBackground: async (_id, target, side) => { marked.push([side, target]) },
      compact: async (id, side) => { compacted.push([side, id]); return { message: 'done' } }
    })
    const operation = await service.run('front', { manual: true })
    assert.equal(operation.status, 'completed')
    assert.ok(compacted.some(([side, id]) => side === member && id === member + '-session'))
    assert.ok(marked.some(([side, id]) => side === member && id === member + '-session'))
  })
}
