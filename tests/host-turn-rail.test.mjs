// 轮次导航（domain/host-turn-rail.js）：`turnOutline` 发出去之前裁到表面里还有内容的轮次。
import assert from 'node:assert/strict'
import test from 'node:test'
import { installHostTurnRailFilter } from '../tavern-plugin/lib/domain/host-turn-rail.js'

const entry = (turn, seq) => ({ turn, seq, prompt: '第 ' + turn + ' 轮输入', response: '第 ' + turn + ' 轮正文' })

function session(nodes, replaceGeneration = 0) {
  return { surface: { nodes, replaceGeneration } }
}

function registry(state) {
  const listeners = new Set()
  const store = { registrations: new Map(), listeners, snapshot: undefined }
  return Object.assign(store, {
    snapshot(current, keys) {
      return { asOfSeq: 99, values: { turnOutline: state.outline, inbox: state.inbox, sessionStats: { turns: 1 } } }
    },
    cachedSnapshot() { return { asOfSeq: 42, values: { turnOutline: state.outline } } },
    hydrate() { return { asOfSeq: 7, values: { turnOutline: state.outline } } },
    onChanged(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  })
}

// turn 1..4，边界 seq 0/10/20/30；表面只剩第 1、3 轮的内容（第 2 轮失败重试、第 4 轮是被取代的尝试）。
const outline = [entry(1, 0), entry(2, 10), entry(3, 20), entry(4, 30)]
const liveNodes = [1, 5, 23, 27]

test('批量通知保留非目录项、顺序、seq 和原始数据，支持早晚订阅及完整卸载', () => {
  const host = registry({ outline, inbox: [] })
  host.eventListeners = new Set()
  host.onEventChanged = function (listener) {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }
  const original = host.onEventChanged, seen = [], current = session(liveNodes)
  const early = (...args) => seen.push(['early', ...args])
  const offEarly = host.onEventChanged(early)
  const dispose = installHostTurnRailFilter(host), again = installHostTurnRailFilter(host)
  const late = (...args) => seen.push(['late', ...args])
  const offLate = host.onEventChanged(late)
  const other = { key: 'inbox', val: ['untouched'], extra: 1 }
  const changes = [other, { key: 'turnOutline', val: outline, extra: 2 }]
  const before = structuredClone(changes)
  const fire = data => { for (const listener of host.eventListeners) listener(current, data, 77) }
  fire(changes)
  assert.deepEqual(seen.map(row => row[0]), ['early', 'late'])
  for (const [, owner, data, seq] of seen) {
    assert.equal(owner, current)
    assert.equal(seq, 77)
    assert.equal(data[0], other)
    assert.deepEqual(data[1], { key: 'turnOutline', val: [outline[0], outline[2]], extra: 2 })
  }
  assert.deepEqual(changes, before)
  offEarly()
  seen.length = 0
  const unchanged = [other]
  fire(unchanged)
  assert.equal(seen.length, 1, '安装前返回的取消函数仍然有效')
  assert.equal(seen[0][2], unchanged, '无需过滤时保留批次数组身份')
  dispose()
  assert.notEqual(host.onEventChanged, original, '引用计数尚未归零')
  again()
  assert.equal(host.onEventChanged, original)
  assert.equal(Object.hasOwn(host.eventListeners, 'delete'), false)
  assert.deepEqual([...host.eventListeners], [late])
  offLate()
  assert.equal(host.eventListeners.size, 0)
})

test('单项通知安装前的取消函数仍能释放已包装监听器', () => {
  const host = registry({ outline, inbox: [] })
  const off = host.onChanged(() => assert.fail('已取消的订阅不能触发'))
  const dispose = installHostTurnRailFilter(host)
  off()
  assert.equal(host.listeners.size, 0)
  dispose()
  assert.equal(host.listeners.size, 0)
})

test('变更推送只裁 turnOutline，监听器按原顺序收发', () => {
  const seen = []
  const host = registry({ outline, inbox: [] })
  const early = (current, key, value) => seen.push([key, value])
  host.listeners.add(early)
  const dispose = installHostTurnRailFilter(host)
  const lateSeen = []
  const lateListener = (current, key, value) => lateSeen.push([key, value])
  const offLate = host.onChanged(lateListener)
  const fire = (key, value) => { for (const listener of host.listeners) listener(session(liveNodes), key, value, 31) }
  fire('turnOutline', outline)
  fire('inbox', ['x'])
  assert.deepEqual(seen, [['turnOutline', [outline[0], outline[2]]], ['inbox', ['x']]])
  assert.deepEqual(lateSeen, [['turnOutline', [outline[0], outline[2]]], ['inbox', ['x']]])
  assert.equal(host.listeners.size, 2, '已有的与补装的监听器都还在')
  dispose()
  assert.deepEqual([...host.listeners], [early, lateListener], '卸载时换回原监听器，顺序不变')
  offLate()
  assert.deepEqual([...host.listeners], [early], '补装的监听器卸载后连原函数一起取消')
})

test('没有要裁的条目时保持原数组身份，表面没变时复用结果', () => {
  const state = { outline, inbox: [] }
  const host = registry(state)
  const dispose = installHostTurnRailFilter(host)
  const kept = [outline[0], outline[1]]
  state.outline = kept
  const current = session(liveNodes)
  assert.equal(host.snapshot(current).values.turnOutline, kept, '不裁就不换引用')
  state.outline = outline
  const first = host.snapshot(current).values.turnOutline
  assert.equal(host.snapshot(current).values.turnOutline, first, '同一份表面复用裁剪结果')
  const moved = session([1, 5, 12, 23])
  assert.deepEqual(host.snapshot(moved).values.turnOutline.map(item => item.turn), [1, 2, 3], '表面变了重新算')
  dispose()
})
