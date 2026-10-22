import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// Fork contract C5: the tavernStory browser service forwards to the existing RPCs.
const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
const React = { createElement: (type, props) => ({ type, props }), Fragment: 'Fragment', memo: value => value, forwardRef: value => value, createContext: () => ({}) }
function loadClient(replies = {}) {
  let descriptor
  const calls = []
  const window = { __ModuleLoader__: { load(value) { descriptor = value } }, setTimeout, clearTimeout, dispatchEvent() {}, addEventListener() {}, removeEventListener() {} }
  const fetch = async (url, request) => {
    const method = url.split('/').pop()
    const { _performance, _traceId, ...args } = JSON.parse(request.body)
    calls.push({ method, args })
    const reply = replies[method]
    const body = typeof reply === 'function' ? reply(args) : Array.isArray(reply) ? reply.shift() : reply
    // Reads the test does not care about (view refreshes) fail quietly.
    const result = body === undefined ? { ok: false, error: 'not in test' } : body.error ? { ok: false, error: body.error } : { ok: true, ...body }
    return { ok: true, status: 200, text: async () => JSON.stringify(result) }
  }
  const context = { window, fetch, performance, console, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } } }
  vm.runInNewContext(source, context)
  const client = descriptor.factory(name => name === 'react' ? React : {})
  // The history projection reads the page; the bundle itself loads without one.
  context.document = { body: {}, querySelectorAll: () => [], querySelector: () => null }
  return { client, calls }
}
// A host event window as ctx.sessions.binding(sid).eventSource exposes it.
const plain = value => JSON.parse(JSON.stringify(value))
function eventWindow(events) {
  const listeners = new Set()
  let snapshot = { entries: events.map(event => ({ type: 'event', event })), hasMore: false, revision: 0, change: { kind: 'replace', entries: [] } }
  return {
    source: { getSnapshot: () => snapshot, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) } },
    append(entry) { snapshot = { ...snapshot, entries: [...snapshot.entries, entry], revision: snapshot.revision + 1, change: { kind: 'append', entries: [entry] } }; listeners.forEach(fn => fn()) },
    prepend(events, hasMore) { const entries = events.map(event => ({ type: 'event', event })); snapshot = { entries: [...entries, ...snapshot.entries], hasMore, revision: snapshot.revision + 1, change: { kind: 'prepend', entries } }; listeners.forEach(fn => fn()) }
  }
}
function story(rounds, { failLast = false } = {}) {
  const events = []
  let seq = 0
  for (let turn = 1; turn <= rounds; turn++) {
    events.push({ type: 'turn/start', seq: ++seq, time: 1, data: { turn } })
    events.push({ type: 'user/message', seq: ++seq, time: 1, surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '输入' + turn }] } })
    const failed = failLast && turn === rounds
    if (!failed) events.push({ type: 'assistant/message', seq: ++seq, time: 1, surfaceOp: 'append', data: { turn, message: { id: 'r' + turn, source: { kind: 'model' }, content: [{ type: 'text', text: '正文' + turn }] } } })
    events.push({ type: 'turn/end', seq: ++seq, time: 1, data: { turn, reason: { kind: failed ? 'interrupted' : 'completed' } } })
  }
  return events
}
function serviceOf(client, windows) {
  return client.createTavernStoryService({ sessions: { binding: id => windows[id] ? { eventSource: windows[id].source } : undefined }, actions: client.playControlsFeature.storyActions })
}

test('subscribeRounds 用事件窗口折叠楼层：追加增量、流式块不回调、加载更早历史重新折叠', () => {
  const { client } = loadClient()
  const window = eventWindow(story(3).slice(4))
  const service = serviceOf(client, { s1: window })
  const seen = []
  const stop = service.subscribeRounds('s1', rounds => seen.push(rounds))
  assert.deepEqual(plain(seen[0].floors.map(floor => floor.story)), [2, 3])
  assert.equal(seen[0].from, 5)
  window.append({ type: 'transient', event: { type: 'assistant/live-chunk', seq: 13, data: {} } })
  assert.equal(seen.length, 1, '流式块不改变楼层，不回调')
  for (const event of story(4).slice(12)) window.append({ type: 'event', event })
  assert.deepEqual(plain(seen.at(-1).floors.map(floor => floor.story)), [2, 3, 4])
  window.prepend(story(1), false)
  assert.deepEqual(plain(seen.at(-1).floors.map(floor => floor.story)), [1, 2, 3, 4])
  assert.equal(seen.at(-1).floors[0].inputs[0].text, '输入1')
  stop()
  assert.throws(() => service.subscribeRounds('missing', () => {}), /没有在当前页面打开/)
})

test('readInterruptedInput 取回中断回合的原输入；玩家发了新输入后为空', () => {
  const { client } = loadClient()
  const events = story(3, { failLast: true })
  const window = eventWindow(events)
  const service = serviceOf(client, { s1: window })
  assert.deepEqual({ ...service.readInterruptedInput('s1') }, { seq: 10, turn: 3, text: '输入3', reason: 'interrupted' })
  window.append({ type: 'event', event: { type: 'user/message', seq: 13, time: 1, surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '新输入' }] } } })
  assert.equal(service.readInterruptedInput('s1'), null, '玩家发出新输入后不再提示')
})

test('rollbackTo 先结清失败尾部再逐层回退到目标楼层', async () => {
  const { client, calls } = loadClient({ rollbackTurn: [
    { view: { mode: 'story', rollbackTargetTurn: 3, canClearIncompleteReply: false, clearedInput: '原输入' } },
    { view: { mode: 'story', rollbackTargetTurn: 2 } },
    { view: { mode: 'story', rollbackTargetTurn: 1 } }
  ] })
  const service = serviceOf(client, {})
  client.liveTavernView.setView('s1', { mode: 'story', rollbackTargetTurn: 3, canClearIncompleteReply: true })
  const result = await service.rollbackTo('s1', 2)
  assert.deepEqual(calls.filter(call => call.method === 'rollbackTurn').map(call => call.args), [
    { expectedTurn: null, sessionId: 's1' }, { expectedTurn: 3, sessionId: 's1' }, { expectedTurn: 2, sessionId: 's1' }])
  assert.deepEqual([...result.rolledBack], [3, 2])
  assert.equal(result.clearedInput, '原输入')
  await assert.rejects(service.rollbackTo('s1', 5), /不是现有楼层/)
})

test('regenerate / regenerateWithGuidance 走正文重生成流程并记住引导；非最新楼层不发请求', async () => {
  const { client, calls } = loadClient({ regenBody: () => ({ view: { mode: 'story', rollbackTargetTurn: 3, canRegenerate: true } }) })
  const service = serviceOf(client, { s1: eventWindow(story(3)) })
  client.liveTavernView.setView('s1', { mode: 'story', rollbackTargetTurn: 3, canRegenerate: true })
  await service.regenerate('s1', 3)
  await service.regenerateWithGuidance('s1', 3, '  更紧张一点 ')
  const regen = calls.filter(call => call.method === 'regenBody').map(call => call.args)
  assert.deepEqual(regen, [{ guidance: '', sessionId: 's1' }, { guidance: '更紧张一点', sessionId: 's1' }])
  assert.equal(service.guidance('s1'), '更紧张一点', '与 dock 的「按要求改写」共用引导记忆')
  await assert.rejects(service.regenerate('s1', 2), /最新楼层/)
  await assert.rejects(service.regenerateWithGuidance('s1', 3, ' '), /非空 guidance/)
  assert.equal(calls.filter(call => call.method === 'regenBody').length, 2)
})

test('regenerate 失败时抛出服务端原因', async () => {
  const { client } = loadClient({ regenBody: { error: '前台正在生成' } })
  const service = serviceOf(client, { s1: eventWindow(story(2)) })
  client.liveTavernView.setView('s1', { mode: 'story', rollbackTargetTurn: 2, canRegenerate: true })
  client.playControlsFeature.storyActions.interactions.regeneration.set(null)
  await assert.rejects(service.regenerate('s1', 2), /前台正在生成/)
  assert.equal(client.playControlsFeature.storyActions.interactions.regeneration.getSnapshot(), null)
})

test('retryFailed 重放失败回合；快照按楼层来源写入、读回时丢弃过期条目', async () => {
  const { client, calls } = loadClient({
    replayTurn: { view: { mode: 'story' } },
    saveFloorSnapshot: { saved: true, snapshot: { turn: 3 } },
    getFloorSnapshots: { snapshots: { 2: { turn: 2, reply: '7', html: '<p>旧</p>', truncated: false }, 3: { turn: 3, reply: '99', html: '<p>过期</p>' } } }
  })
  const service = serviceOf(client, {})
  await service.retryFailed('s1')
  assert.deepEqual(calls.find(call => call.method === 'replayTurn').args, { sessionId: 's1' })
  const floor = { story: 3, reply: { seq: 11 } }
  await service.writeFloorSnapshot('s1', floor, { html: '<p>静态</p>', truncated: true })
  assert.deepEqual(calls.find(call => call.method === 'saveFloorSnapshot').args, { turn: 3, reply: '11', html: '<p>静态</p>', truncated: true, sessionId: 's1' })
  const snapshots = await service.readFloorSnapshots('s1', [{ story: 2, reply: { seq: 7 } }, floor])
  assert.deepEqual(calls.find(call => call.method === 'getFloorSnapshots').args, { turns: [2, 3], sessionId: 's1' })
  assert.deepEqual(Object.keys(snapshots), ['2'], '来源回复不符的快照不返回')
  assert.equal(await service.readFloorSnapshot('s1', floor), null)
})

test('listResults 列出楼层历史结果；switchResult 明确报不支持', async () => {
  const { client } = loadClient()
  const service = serviceOf(client, { s1: eventWindow(story(2)) })
  assert.deepEqual(plain(service.listResults('s1', 2).map(item => [item.text, item.current])), [['正文2', true]])
  assert.equal(service.listResults('s1', 9), null)
  await assert.rejects(service.switchResult('s1', 2, 1), error => error.code === 'unsupported')
})
