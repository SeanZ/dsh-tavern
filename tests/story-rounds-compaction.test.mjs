import test from 'node:test'
import assert from 'node:assert/strict'
import { createStoryRoundsFold, foldStoryRounds } from '../tavern-plugin/lib/story/story-rounds.js'

// 合成日志保留真实 Surface 替换协议，避免把摘要文本误当故事正文。
function fixture() {
  const events = []
  const add = (type, data, extra = {}) => {
    const event = { seq: events.length, type, data, ...extra }
    events.push(event)
    return event.seq
  }
  function play(turn) {
    add('turn/start', { turn })
    const input = add('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '输入' + turn }] }, { surfaceOp: 'append' })
    const reply = add('assistant/message', { turn, message: { id: 'reply-' + turn, source: { kind: 'model' }, content: [{ type: 'text', text: '正文' + turn }] } }, { surfaceOp: 'append' })
    add('turn/end', { turn, reason: { kind: 'completed' } })
    return { input, reply }
  }
  const replace = (seqs, kind, text = '摘要') => add('user/message', { source: { kind }, content: text ? [{ type: 'text', text }] : [] }, {
    surfaceOp: { op: 'replace', startSeq: seqs[0], endSeq: seqs.at(-1) }, sourceEventSeqs: seqs
  })
  return { events, play, replace }
}

test('多次压缩保留正文、输入与身份，分页重建和增量一致', () => {
  const f = fixture(), nodes = []
  for (let turn = 1; turn <= 45; turn++) { const row = f.play(turn); nodes.push(row.input, row.reply) }
  const before = foldStoryRounds(f.events)
  const fold = createStoryRoundsFold(); fold.addEvents(f.events)
  const first = f.replace(nodes.slice(0, 60), 'compact-checkpoint')
  const second = f.replace([first, ...nodes.slice(60, 80)], 'compact-checkpoint')
  fold.addEvents(f.events)
  assert.deepEqual(fold.result(), before)
  assert.deepEqual(foldStoryRounds(JSON.parse(JSON.stringify(f.events))), before)
  assert.deepEqual(foldStoryRounds(f.events.slice(40)).floors, before.floors.slice(10), '窗口从旧楼中间开始时只展示已加载部分')
  // 从摘要之后起读时没有虚构旧楼；加载更早日志后恢复完整历史。
  assert.equal(foldStoryRounds(f.events.slice(second)).floors.length, 0)
  const paged = createStoryRoundsFold()
  for (let offset = 0; offset < f.events.length; offset += 13) paged.addEvents(f.events.slice(offset, offset + 13))
  assert.deepEqual(paged.result(), before)
})

test('撤回摘要覆盖的区间后不复活旧楼层，普通替换不视为压缩', () => {
  const f = fixture(), a = f.play(1), b = f.play(2), c = f.play(3)
  const compact = f.replace([a.input, a.reply, b.input, b.reply], 'compact-checkpoint')
  f.replace([compact, c.input, c.reply], 'plugin:rollback', '')
  assert.deepEqual(foldStoryRounds(f.events).floors, [])
  assert.ok(foldStoryRounds(f.events).abandoned.every(input => input.reason === 'rolled-back'))
  const g = fixture(), row = g.play(1)
  g.replace([row.input, row.reply], 'plugin:edit', '普通替换')
  assert.deepEqual(foldStoryRounds(g.events).floors, [])
})

test('压缩前已被替换的正文不因展开摘要而复活', () => {
  const f = fixture(), a = f.play(1), b = f.play(2)
  const removed = f.replace([a.input, a.reply], 'plugin:rollback', '')
  const before = foldStoryRounds(f.events)
  f.replace([removed, b.input, b.reply], 'compact-checkpoint')
  assert.deepEqual(foldStoryRounds(f.events), before)
  assert.deepEqual(before.floors.map(floor => floor.story), [2])
})


test('千轮历史经多段压缩仍可从尾页逐步补齐到开场，不受50或100层限制', () => {
  const f = fixture(), nodes = []
  for (let turn = 1; turn <= 1000; turn++) { const row = f.play(turn); nodes.push(row.input, row.reply) }
  const before = foldStoryRounds(f.events).floors
  const first = f.replace(nodes.slice(0, 600), 'compact-checkpoint')
  const second = f.replace([first, ...nodes.slice(600, 1200)], 'compact-checkpoint')
  f.replace([second, ...nodes.slice(1200, 1800)], 'compact-checkpoint')
  for (const start of [3600, 2400, 1200, 0]) {
    assert.deepEqual(foldStoryRounds(f.events.slice(start)).floors, before.slice(start / 4))
  }
})

for (const source of [
  { kind: 'compact-checkpoint' }, { kind: 'plugin:compact' },
  { kind: 'plugin', plugin: 'dsh-compaction-basic' },
  { kind: 'plugin:dsh-tavern', form: 'compaction-checkpoint-rewrite' },
  { kind: 'plugin', plugin: 'dsh-tavern', form: 'compaction-checkpoint-rewrite' }
]) test('共享摘要来源保留楼层及压缩边界：' + JSON.stringify(source), () => {
  const f = fixture(), a = f.play(1), b = f.play(2)
  const before = foldStoryRounds(f.events)
  const first = f.replace([a.input, a.reply, b.input, b.reply], 'compact-checkpoint')
  const rewrite = f.replace([first], source.kind)
  f.events[rewrite].data.source = source
  const fold = createStoryRoundsFold(); fold.addEvents(f.events)
  assert.deepEqual(fold.result(), before)
  assert.deepEqual(fold.compactedStories(), [1, 2])
  f.replace([rewrite], 'plugin:rollback', '')
  fold.addEvents(f.events)
  assert.deepEqual(fold.compactedStories(), [])
})
