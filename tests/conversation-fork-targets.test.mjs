import assert from 'node:assert/strict'
import test from 'node:test'
import { forkTurnsByMessageId } from '../tavern-plugin/lib/domain/conversation-fork-targets.js'

const start = (seq, turn) => ({ type: 'turn/start', seq, data: { turn } })
const end = (seq, turn, kind = 'completed') => ({ type: 'turn/end', seq, data: { turn, reason: { kind } } })
const reply = (seq, turn, id, kind = 'model') => ({ type: 'assistant/message', seq, data: { turn, message: { id, source: { kind } } } })
const session = events => ({ events })

test('重新生成的轮次映射回剧情轮次，被替换的原回复不再作为目标', () => {
  const events = [start(1, 1), reply(2, 1, 'a'), end(3, 1),
    start(4, 2), reply(5, 2, 'old-2'), end(6, 2),
    start(7, 3), reply(8, 3, 'regen-2'), end(9, 3)]
  assert.deepEqual(forkTurnsByMessageId(session(events), { 2: 3 }), { a: 1, 'regen-2': 2 })
})

test('一轮有多条模型消息时都能找到这一轮，宿主显示的不一定是最后一条 (#234)', () => {
  const events = [start(1, 1), reply(2, 1, 'opening'), end(3, 1),
    start(4, 2), reply(5, 2, 'tool-step'), reply(6, 2, 'visible'), reply(7, 2, 'projection'), end(8, 2)]
  assert.deepEqual(forkTurnsByMessageId(session(events)), { opening: 1, 'tool-step': 2, visible: 2, projection: 2 })
})


test('分叉入口保留最近200轮，超过窗口的目标退出', () => {
  const events = []
  for (let turn = 1; turn <= 205; turn++) {
    events.push(start(events.length, turn), reply(events.length + 1, turn, 'reply-' + turn), end(events.length + 2, turn))
  }
  const targets = forkTurnsByMessageId(session(events))
  assert.equal(Object.keys(targets).length, 200)
  assert.equal(targets['reply-5'], undefined)
  assert.equal(targets['reply-6'], 6)
  assert.equal(targets['reply-205'], 205)
})
