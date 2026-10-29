import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionStateView } from '../tavern-plugin/lib/domain/chat-session-state.js'

const events = [
  { seq: 0, type: 'user/message', data: { role: 'user', source: { kind: 'user' } } },
  { seq: 1, type: 'assistant/message', data: { turn: 1, message: { source: { kind: 'model', provider: 'p', model: 'm' } } } }
]
const session = { id: 's', events, surface: { nodes: [0, 1] } }
const fields = createSessionStateView({ activity: () => ({ busy: false }), evidence: () => ({ session, events }) })

function viewOf(chat) {
  return fields.rollback({ id: 'c', sessionId: 's', mode: 'story', messages: [], ...chat }, { session, events })
}

// 存档记的是生成期的合成回合，实际正文在提交之后才投影进另一个编辑回合。
// 视图必须以日志为准，否则旧回合会被当成当前正文继续显示。
const projectedEvents = [
  { seq: 0, type: 'user/message', data: { role: 'user', source: { kind: 'user' } } },
  { seq: 1, type: 'assistant/message', data: { turn: 1, message: { source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: '开场' }] } } },
  { seq: 2, type: 'assistant/message', data: { turn: 11, message: { source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: '被替换的正文' }] } } },
  { seq: 3, type: 'assistant/message', surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2],
    data: { turn: 12, message: { source: { kind: 'model', provider: 'p', model: 'm', tavernStoryTurn: 4 }, content: [{ type: 'text', text: '新正文' }] } } }
]
const projectedSession = { id: 's', events: projectedEvents, surface: { nodes: [0, 1, 3] } }

test('投影记在哪个原生回合，视图就指向哪个回合', () => {
  const view = fields.rollback({ id: 'c', sessionId: 's', mode: 'story', messages: [],
    regeneratedDshTurns: { 4: 11 }, suppressedDshTurns: [11] }, { session: projectedSession, events: projectedEvents })
  assert.equal(view.regeneratedDshTurns[4], 12, '存档里的 11 是生成期回合，正文实际在 12')
  assert.deepEqual(view.supersededDshTurns, [11], '旧回合的正文已被替换，页面不能再画')
})

// 「正文走工具调用」的回合没有自己的流式正文：唯一能画的是折叠写下的那份 append。
// 重新生成后那份副本仍留在被替换的回合里。若把它连同旧回合一起隐藏，页面上就一条正文
// 都不剩（替换副本只给模型），表现为「轨迹里有、对话里没有」。宁可保留那一回合。
const foldOnlyEvents = [
  { seq: 0, type: 'user/message', data: { role: 'user', source: { kind: 'user' } } },
  { seq: 1, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, message: { source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: '开场' }] } } },
  { seq: 2, type: 'assistant/message', surfaceOp: 'append', data: { turn: 4, message: { source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'Pass' }] } } },
  { seq: 3, type: 'assistant/message', surfaceOp: 'append', data: { turn: 6, message: { source: { kind: 'model', provider: 'dsh-tavern', model: 'reply-projection' }, content: [{ type: 'text', text: '正文' }] } } },
  { seq: 4, type: 'assistant/message', surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 }, sourceEventSeqs: [2, 3],
    data: { turn: 7, message: { source: { kind: 'model', provider: 'p', model: 'm', tavernStoryTurn: 4 }, content: [{ type: 'text', text: '正文' }] } } }
]
const foldOnlySession = { id: 's', events: foldOnlyEvents, surface: { nodes: [0, 1, 4] } }

// 普通回合（没走工具调用）：重新生成那一轮自己流式写下的回复就是唯一能画的正文，
// 投影只是替换，落在另一个编辑回合里，对话页画不出来（#283）。
// 回合修复把跳号的日志重新编号后，存档里记的「作废第 5 轮」指向了新正文所在的编辑回合。
// 生成期那一轮要按它的重新生成输入从日志里认出来，回合号怎么变都找得到（#283）。
test('生成期回合按重新生成输入从日志认出，不依赖存档里可能错位的回合号', () => {
  const model = { kind: 'model', provider: 'p', model: 'm' }
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 3 } },
    { seq: 1, type: 'user/message', surfaceOp: 'append', data: { role: 'user', source: { kind: 'user' } } },
    { seq: 2, type: 'assistant/message', surfaceOp: 'append', data: { turn: 3, step: 1, message: { source: model, content: [{ type: 'text', text: '旧正文' }] } } },
    { seq: 3, type: 'turn/end', data: { turn: 3 } },
    { seq: 4, type: 'turn/start', data: { turn: 4 } },
    { seq: 5, type: 'user/message', surfaceOp: 'append', data: { role: 'user', source: { kind: 'plugin:dsh-tavern-regen' } } },
    { seq: 6, type: 'assistant/message', surfaceOp: 'append', data: { turn: 4, step: 1, message: { source: model, content: [{ type: 'text', text: '新正文' }] } } },
    { seq: 7, type: 'turn/end', data: { turn: 4 } },
    { seq: 8, type: 'turn/start', data: { turn: 5 } },
    { seq: 9, type: 'assistant/message', surfaceOp: { op: 'replace', startSeq: 2, endSeq: 6 }, sourceEventSeqs: [2, 5, 6],
      data: { turn: 5, step: 1, message: { source: { ...model, tavernStoryTurn: 3 }, content: [{ type: 'text', text: '新正文' }] } } },
    { seq: 10, type: 'turn/end', data: { turn: 5 } }
  ]
  const session = { id: 's', events, surface: { nodes: [1, 9] } }
  // 存档里记的是重新编号前的「5」。
  const view = fields.rollback({ id: 'c', sessionId: 's', mode: 'story', messages: [], suppressedDshTurns: [5] }, { session, events })
  assert.equal(view.regeneratedDshTurns[3], 4, '正文画在生成期那一轮')
  assert.ok(view.suppressedDshTurns.includes(4), '生成期那一轮被认出：客户端只收掉它的「收到执行请求」，回复留着')
})

// 旧存档的工具回合：正文副本是在提交时折叠进生成期那一轮的 append，随后又被替换
// 副本盖住；重新生成的范围把折叠替换也包了进去，末尾落在一个替换节点上。只看
// range 末尾会映射到没有任何可画行的编辑回合，生成期那一轮又被当成作废回合，
// 整轮正文于是消失（#283 的旧档形态）。
const oldToolFoldEvents = [
  { seq: 0, type: 'user/message', data: { role: 'user', source: { kind: 'user' } } },
  { seq: 1, type: 'assistant/message', surfaceOp: 'append', data: { turn: 4, message: { source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: '工具回合的旧流' }] } } },
  { seq: 2, type: 'user/message', surfaceOp: 'append', data: { role: 'user', source: { kind: 'plugin:dsh-tavern-regen' } } },
  { seq: 3, type: 'assistant/message', surfaceOp: 'append', data: { turn: 5, message: { source: { kind: 'model', provider: 'dsh-tavern', model: 'reply-projection' }, content: [{ type: 'text', text: '工具回合的旧流' }] } } },
  { seq: 4, type: 'assistant/message', surfaceOp: { op: 'replace', startSeq: 1, endSeq: 3 }, sourceEventSeqs: [1, 2, 3],
    data: { turn: 5, message: { source: { kind: 'model', provider: 'dsh-tavern', model: 'reply-projection' }, content: [{ type: 'text', text: '工具回合的旧流' }] } } },
  { seq: 5, type: 'assistant/message', surfaceOp: { op: 'replace', startSeq: 1, endSeq: 4 }, sourceEventSeqs: [1, 2, 3, 4],
    data: { turn: 6, message: { source: { kind: 'model', provider: 'p', model: 'm', tavernStoryTurn: 4 }, content: [{ type: 'text', text: '重新生成后的新正文' }] } } }
]
const oldToolFoldSession = { id: 's', events: oldToolFoldEvents, surface: { nodes: [0, 5] } }

test('旧工具回合重新生成后，映射指向仍可画的折叠副本，而不是没有行的编辑回合', () => {
  const view = fields.rollback({ id: 'c', sessionId: 's', mode: 'story', messages: [] },
    { session: oldToolFoldSession, events: oldToolFoldEvents })
  assert.equal(view.regeneratedDshTurns[4], 5, '折叠副本画在生成期那一轮')
  assert.deepEqual(view.supersededDshTurns, [4], '只藏旧流所在的回合')
})

// 视图映射出来的那一轮就是这一轮正文唯一可见的副本。即使另一份可画的副本也在
// 被替换名单里，也不能把映射指向的回合藏掉，否则页面只剩玩家输入（#283）。
// 失败轮的玩家输入被重试采用：输入和正文不在同一个原生回合，作废名单会连输入
// 一起收掉。视图要指明保留哪一条输入，客户端只藏失败残留和触发卡。
const adoptedEvents = [
  { seq: 0, type: 'turn/start', data: { turn: 1 } },
  { seq: 1, type: 'user/message', surfaceOp: 'append', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第一句' }] } },
  { seq: 2, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: '第一段' }] } } },
  { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  { seq: 4, type: 'turn/start', data: { turn: 2 } },
  { seq: 5, type: 'user/message', surfaceOp: 'append', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第二句' }] } },
  { seq: 6, type: 'turn/end', data: { turn: 2, reason: { kind: 'error' } } },
  { seq: 7, type: 'turn/start', data: { turn: 3 } },
  { seq: 8, type: 'user/message', surfaceOp: 'append', data: { role: 'user', source: { kind: 'plugin:dsh-tavern-regen' }, content: [{ type: 'text', text: '第二句' }] } },
  { seq: 9, type: 'assistant/message', surfaceOp: 'append', data: { turn: 3, step: 1, message: { source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'Pass' }] } } },
  { seq: 10, type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } }
]
const adoptedSession = { id: 's', events: adoptedEvents, surface: { nodes: [1, 2, 5, 8, 9] } }

test('失败轮的输入被重试采用时，视图保留那一轮的玩家输入', () => {
  const view = fields.rollback({ id: 'c', sessionId: 's', mode: 'story', regenInProgress: true,
    messages: [{ role: 'assistant', turn: 1, text: '第一段' }], suppressedDshTurns: [2] }, { session: adoptedSession, events: adoptedEvents })
  assert.deepEqual(view.keptInputTurns, [2])
  assert.ok(view.suppressedDshTurns.includes(2), '作废轮仍然作废，只是输入不跟着藏')
})
