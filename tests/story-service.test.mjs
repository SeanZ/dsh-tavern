import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from './fixtures/client-vm.mjs'

// Fork contract C5: the tavernStory browser service forwards to the existing RPCs.
const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
const React = { createElement: (type, props) => ({ type, props }), Fragment: 'Fragment', memo: value => value, forwardRef: value => value, createContext: () => ({}) }
function loadClient(replies = {}) {
  let descriptor
  const calls = []
  // 视图缓存在退订后保留 10 分钟：测试里的计时器不拖住进程。
  const window = { __ModuleLoader__: { load(value) { descriptor = value } }, setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout, dispatchEvent() {}, addEventListener() {}, removeEventListener() {} }
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
  const context = { window, fetch, performance, console, AbortController, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } } }
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
    // 宿主 settleAssistant：撤掉这次尝试的临时条目，插入落定的正文事件。
    settle(attemptId, event) { const entries = snapshot.entries.filter(entry => entry.type !== 'transient' || entry.event.data.attemptId !== attemptId).concat(event ? [{ type: 'event', event }] : []); snapshot = { ...snapshot, entries, revision: snapshot.revision + 1, change: { kind: 'settle-assistant', attemptId, ...(event ? { entry: { type: 'event', event } } : {}) } }; listeners.forEach(fn => fn()) },
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

test('interruptQueued 转调原生回合限定的契约，拒绝无效参数', async () => {
  const { client, calls } = loadClient({ interruptStoryQueue: {interrupted:true} })
  const service = serviceOf(client, {})
  assert.equal((await service.interruptQueued('s1', 4)).interrupted, true)
  assert.deepEqual(calls[0], {method:'interruptStoryQueue',args:{turn:4,sessionId:'s1'}})
  assert.throws(() => service.interruptQueued('s1', 0), /正整数/)
  assert.throws(() => service.interruptQueued('', 4), /sessionId/)
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

test('subscribeRounds 透传未写入 user/message 的准备和失败状态，不创建楼层', () => {
  const { client } = loadClient()
  const window = eventWindow([])
  const seen = []
  const service = serviceOf(client, { s1: window })
  const stop = service.subscribeRounds('s1', value => seen.push(value))
  const events = [
    { type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-turn', start: 0, inserted: [{ id: 'early', source: { kind: 'user' }, content: [{ type: 'text', text: '原输入' }] }] } },
    { type: 'turn/start', seq: 2, data: { turn: 1 } },
    // 宿主在 turn/start 之后立即认领本轮那一条。
    { type: 'agent/inbox/spliced', seq: 3, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'error', error: { message: '模板初始化失败' } } } }
  ]
  for (const event of events) window.append({ type: 'event', event })
  assert.equal(seen.at(-2).attempt.phase, 'preparing')
  assert.equal(seen.at(-1).attempt.error, '模板初始化失败')
  assert.equal(seen.at(-1).attempt.inputs[0].text, '原输入')
  assert.equal(seen.at(-1).interrupted, null, '不冒充可回放的原生输入')
  assert.equal(seen.at(-1).floors.length, 0)
  stop()
})

test('自动打断后下一条早期失败：interrupted 不再报告被打断的那一轮，attempt 给出失败的那条', () => {
  const { client } = loadClient()
  const splice = (seq, data) => ({ type: 'agent/inbox/spliced', seq, data: { target: 'next-turn', inserted: [], ...data } })
  const user = text => ({ id: text, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const events = [...story(1), { type: 'turn/start', seq: 5, data: { turn: 2 } },
    { type: 'user/message', seq: 6, surfaceOp: 'append', data: user('第一句') },
    splice(7, { start: 0, inserted: [user('甲')] }), splice(8, { start: 0, removedCount: 1, outcome: 'canceled' }), splice(9, { start: 0, inserted: [user('甲')] }),
    { type: 'turn/end', seq: 10, data: { turn: 2, reason: { kind: 'aborted' } } },
    { type: 'turn/start', seq: 11, data: { turn: 3 } }, splice(12, { start: 0, removedCount: 1 }),
    { type: 'turn/end', seq: 13, data: { turn: 3, reason: { kind: 'error', error: { message: '模板失败' } } } }]
  const service = serviceOf(client, { s1: eventWindow(events) })
  const seen = []
  service.subscribeRounds('s1', rounds => seen.push(rounds))()
  assert.equal(seen[0].abandoned.at(-1).reason, 'superseded')
  assert.equal(seen[0].interrupted, null)
  assert.equal(service.readInterruptedInput('s1'), null)
  assert.deepEqual([seen[0].attempt.phase, seen[0].attempt.inputs[0].text], ['error', '甲'])
})
