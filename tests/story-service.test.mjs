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
  const service = serviceOf(client, { s1: eventWindow(story(3)) })
  client.liveTavernView.setView('s1', { mode: 'story', rollbackTargetTurn: 3, canClearIncompleteReply: true })
  const result = await service.rollbackTo('s1', 2)
  assert.deepEqual(plain(result.input), { text: '输入2' }, '被撤回首层的原输入，供放回输入框')
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

test('listResults 列出模型每次生成的原文，current 跟随结果切换；switchResult 转调 switchFloorResult', async t => {
  const regenerated = [...story(2),
    { type: 'turn/start', seq: 9, time: 1, data: { turn: 3 } },
    { type: 'user/message', seq: 10, time: 1, surfaceOp: 'append', data: { source: { kind: 'plugin:dsh-tavern-regen' }, content: [{ type: 'text', text: '重写' }] } },
    { type: 'assistant/message', seq: 11, time: 1, surfaceOp: 'append', data: { turn: 3, message: { id: 'r3', source: { kind: 'model' }, content: [{ type: 'text', text: '重写正文2' }] } } },
    { type: 'turn/end', seq: 12, time: 1, data: { turn: 3, reason: { kind: 'completed' } } },
    { type: 'assistant/message', seq: 13, time: 1, surfaceOp: { op: 'replace', startSeq: 7, endSeq: 11 }, sourceEventSeqs: [7, 11],
      data: { turn: 3, message: { id: 'x', source: { kind: 'model', tavernStoryTurn: 2, tavernResultSeq: 7 }, content: [{ type: 'text', text: '正文2' }] } } }]
  const { client, calls } = loadClient({ switchFloorResult: { switched: true, turn: 2, replySeq: 11, mvu: 'stale', view: { mode: 'story' } } })
  const service = serviceOf(client, { s1: eventWindow(regenerated) })
  assert.deepEqual(plain(service.listResults('s1', 2).map(item => [item.seq, item.text, item.current])), [[7, '正文2', true], [11, '重写正文2', false]], '切换后 current 指向 tavernResultSeq 那次生成')
  assert.equal(service.listResults('s1', 9), null)
  client.liveTavernView.setView('s1', { mode: 'story', rollbackTargetTurn: 2, canRegenerate: true })
  const result = await service.switchResult('s1', 2, 11)
  assert.deepEqual(calls.find(call => call.method === 'switchFloorResult').args, { turn: 2, replySeq: 11, sessionId: 's1' })
  assert.deepEqual(plain(result), { switched: true, turn: 2, replySeq: 11, mvu: 'stale', resettle: false, view: { mode: 'story' } }, 'mvu 原样返回；非 MVU 卡没有可重算的变量')
  await assert.rejects(service.switchResult('s1', 1, 3), /最新楼层/)
  await assert.rejects(service.switchResult('s1', 2, 'x'), /replySeq/)
  assert.equal(calls.filter(call => call.method === 'switchFloorResult').length, 1, '前置校验失败不发请求')
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

test('forkAt 前置校验后交给侧栏分叉流程（floor 版 RPC），成功时返回新局；生成中或不在窗口的楼层不发请求', async () => {
  const { client, calls } = loadClient()
  const window = eventWindow(story(3))
  const service = serviceOf(client, { s1: window })
  const requests = []
  const unbind = client.tavernConversationForkRequests.bind(request => { requests.push(request); return { sessionId: 'fork-1', chatId: 'chat-f', turn: request.turn, replySeq: 7 } })
  assert.deepEqual(plain(await service.forkAt('s1', 2)), { sessionId: 'fork-1', chatId: 'chat-f', turn: 2, replySeq: 7 })
  assert.deepEqual(plain(requests), [{ sessionId: 's1', turn: 2, floor: true }])
  await assert.rejects(service.forkAt('s1', 9), /不是当前已加载的楼层/)
  window.append({ type: 'event', event: { type: 'turn/start', seq: 99, time: 1, data: { turn: 4 } } })
  await assert.rejects(service.forkAt('s1', 2), /正在生成/)
  await assert.rejects(service.forkAt('s1', 0), /正整数/)
  assert.equal(requests.length, 1)
  assert.deepEqual(calls.filter(call => /[Ff]ork/.test(call.method)), [], 'forkAt 自己不发分叉请求，交给侧栏')
  // 侧栏的失败原样传给调用方。
  unbind()
  client.tavernConversationForkRequests.bind(() => { throw new Error('源对话已变化，请重新选择分叉楼层') })
  const settled = eventWindow(story(3))
  await assert.rejects(serviceOf(client, { s2: settled }).forkAt('s2', 3), /源对话已变化/)
})

test('侧栏 floor 分叉走 prepareFloorFork → 宿主 fork → forkFloor，失败时抛给调用方', async () => {
  const sidebar = await readFile(new URL('../tavern-plugin/src/client/features/sidebar.js', import.meta.url), 'utf8')
  assert.match(sidebar, /floor\n\t+\? await call\("prepareFloorFork", \{ sessionId: item\.sessionId, turn: Number\(turn\) \|\| 0 \}\)/)
  assert.match(sidebar, /await call\(floor \? "forkFloor" : "forkChat", \{/)
  assert.match(sidebar, /if \(floor\) throw err;/)
  assert.match(sidebar, /forkConversation\(item, title, request\.turn, request\.floor === true\)/)
})

test('subscribeRounds 的 open.liveText 拼接运行中回合的流式正文，节流回调，落定后换成楼层', async () => {
  const { client } = loadClient()
  const events = [...story(2), { type: 'turn/start', seq: 9, time: 1, data: { turn: 3 } },
    { type: 'user/message', seq: 10, time: 1, surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '输入3' }] } }]
  const window = eventWindow(events)
  const service = serviceOf(client, { s1: window })
  const seen = []
  const stop = service.subscribeRounds('s1', rounds => seen.push(rounds))
  assert.equal(seen[0].open.liveText, '', '还没有流式块')
  const chunk = (seq, text, turn = 3, attemptId = 'a1') => ({ type: 'transient', event: { type: 'assistant/live-chunk', seq, time: 1, data: { attemptId, turn, step: 1, chunk: { type: 'text-delta', index: 0, text } } } })
  window.append(chunk(10.1, '雨'))
  window.append({ type: 'transient', event: { type: 'assistant/live-chunk', seq: 10.2, time: 1, data: { attemptId: 'a1', turn: 3, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '思考' } } } })
  window.append(chunk(10.3, '夜里'))
  assert.equal(seen.length, 1, '流式块在节流窗口内不立即回调')
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(seen.length, 2, '一个节流窗口只回调一次')
  assert.equal(seen[1].open.liveText, '雨夜里', '只拼正文，不含思考')
  assert.equal(seen[1].floors, seen[0].floors, '流式块不重新折叠楼层')
  // 同一回合换了一次尝试（重试）：宿主先撤掉失败尝试的临时条目，只显示新尝试的文字。
  window.settle('a1')
  window.append(chunk(10.4, '重来', 3, 'a2'))
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(seen.at(-1).open.liveText, '重来')
  const reply = { type: 'assistant/message', seq: 11, time: 1, surfaceOp: 'append', data: { turn: 3, message: { id: 'r3', source: { kind: 'model' }, content: [{ type: 'text', text: '重来了' }] } } }
  const count = seen.length
  window.settle('a2', reply)
  assert.equal(seen.length, count + 1, '落定立即回调')
  assert.equal(seen.at(-1).open.liveText, '', '落定后临时条目撤掉')
  assert.equal(seen.at(-1).open.reply.text, '重来了')
  window.append({ type: 'event', event: { type: 'turn/end', seq: 12, time: 1, data: { turn: 3, reason: { kind: 'completed' } } } })
  assert.equal(seen.at(-1).open, null)
  assert.deepEqual(plain(seen.at(-1).floors.map(floor => floor.reply.text)), ['正文1', '正文2', '重来了'])
  // 停止订阅后，已排的节流回调不再触发。
  window.append({ type: 'event', event: { type: 'turn/start', seq: 13, time: 1, data: { turn: 4 } } })
  window.append({ type: 'event', event: { type: 'user/message', seq: 14, time: 1, surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '输入4' }] } } })
  window.append(chunk(14.1, '晚', 4, 'a3'))
  const before = seen.length
  stop()
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(seen.length, before)
})

test('subscribeRounds 的 settling 跟随 Tavern 视图的后台结算状态；结算中楼层操作前置拒绝', async () => {
  const { client, calls } = loadClient()
  const window = eventWindow(story(2))
  const service = serviceOf(client, { s1: window })
  const seen = []
  const stop = service.subscribeRounds('s1', rounds => seen.push(rounds))
  assert.equal(seen.at(-1).settling, false)
  const view = { mode: 'story', rollbackTargetTurn: 2, canRegenerate: true }
  client.liveTavernView.setView('s1', { ...view, activity: { phase: 'pending', busy: false } })
  assert.equal(seen.at(-1).settling, true, 'pending 也算结算中')
  const count = seen.length
  client.liveTavernView.setView('s1', { ...view, activity: { phase: 'running', busy: true } })
  assert.equal(seen.length, count, '仍在结算，不重复回调')
  await assert.rejects(service.regenerate('s1', 2), /正在结算/)
  await assert.rejects(service.switchResult('s1', 2, 3), /正在结算/)
  await assert.rejects(service.forkAt('s1', 2), /正在结算/)
  assert.deepEqual(calls.filter(call => ['regenBody', 'switchFloorResult'].includes(call.method)), [])
  client.liveTavernView.setView('s1', { ...view, activity: { phase: 'idle', busy: false } })
  assert.equal(seen.at(-1).settling, false)
  assert.equal(seen.at(-1).floors.length, 2)
  stop()
})

test('subscribeRounds 的 staleVariables 跟随 Tavern 视图的变量未重算标记', () => {
  const { client } = loadClient()
  const service = serviceOf(client, { s1: eventWindow(story(2)) })
  const seen = []
  const stop = service.subscribeRounds('s1', rounds => seen.push(rounds))
  assert.equal(seen.at(-1).staleVariables, null)
  const view = { mode: 'story', rollbackTargetTurn: 2, canRegenerate: true, activity: { phase: 'idle', busy: false } }
  client.liveTavernView.setView('s1', { ...view, staleVariables: { turn: 2, replySeq: 5 } })
  assert.equal(JSON.stringify(seen.at(-1).staleVariables), '{"turn":2,"replySeq":5}')
  const count = seen.length
  client.liveTavernView.setView('s1', { ...view, staleVariables: { turn: 2, replySeq: 5 }, posture: '换了姿态' })
  assert.equal(seen.length, count, '标记没变，不重复回调')
  client.liveTavernView.setView('s1', { ...view, staleVariables: null })
  assert.equal(seen.at(-1).staleVariables, null)
  stop()
})

test('editReply 只编辑最新楼层：get 转调 getBodyEdit，save 带令牌与各文本片段转调 saveBodyEdit', async () => {
  const parts = [{ kind: 'text', text: '正文2' }, { kind: 'html' }]
  const { client, calls } = loadClient({ getBodyEdit: { edit: { token: 't1', turn: 2, parts } }, saveBodyEdit: { view: { mode: 'story', rollbackTargetTurn: 2 } } })
  const service = serviceOf(client, { s1: eventWindow(story(2)) })
  client.liveTavernView.setView('s1', { mode: 'story', rollbackTargetTurn: 2, canRegenerate: true })
  const edit = await service.editReply.get('s1', 2)
  assert.deepEqual(plain(edit), { token: 't1', turn: 2, parts })
  const saved = await service.editReply.save('s1', 2, { token: edit.token, texts: ['改过的正文'] })
  assert.deepEqual(calls.find(call => call.method === 'saveBodyEdit').args, { token: 't1', turn: 2, texts: ['改过的正文'], sessionId: 's1' })
  assert.deepEqual(plain(saved), { view: { mode: 'story', rollbackTargetTurn: 2 } })
  await assert.rejects(service.editReply.get('s1', 1), /最新楼层/)
  await assert.rejects(service.editReply.save('s1', 2, { token: 't1', texts: [1] }), /texts/)
  await assert.rejects(service.editReply.save('s1', 1, { token: 't1', texts: ['x'] }), /最新楼层/)
  assert.equal(calls.filter(call => call.method === 'saveBodyEdit').length, 1, '前置校验失败不发请求')
  // 服务端最新正文已不是这一层（例如另一页刚撤回）时不给令牌。
  const other = loadClient({ getBodyEdit: { edit: { token: 't2', turn: 1, parts } } })
  const stale = serviceOf(other.client, { s1: eventWindow(story(2)) })
  other.client.liveTavernView.setView('s1', { mode: 'story', rollbackTargetTurn: 2, canRegenerate: true })
  await assert.rejects(stale.editReply.get('s1', 2), /已变化/)
})

test('editInput 改最新楼层的玩家输入：按该层输入的原生轮与 seq 读令牌再保存；之后 regenerate 照常', async () => {
  const { client, calls } = loadClient({
    getBodyEdit: { edit: { token: 'u1', role: 'user', index: 3, turn: 2, seq: 6, parts: [{ kind: 'text', text: '输入2' }] } },
    saveBodyEdit: { view: { mode: 'story', rollbackTargetTurn: 2, canRegenerate: true } },
    regenBody: { view: { mode: 'story', rollbackTargetTurn: 2, canRegenerate: true } }
  })
  const service = serviceOf(client, { s1: eventWindow(story(2)) })
  client.liveTavernView.setView('s1', { mode: 'story', rollbackTargetTurn: 2, canRegenerate: true })
  await service.editInput('s1', 2, '改过的输入')
  await service.regenerate('s1', 2)
  assert.deepEqual(calls.filter(call => ['getBodyEdit', 'saveBodyEdit', 'regenBody'].includes(call.method)), [
    { method: 'getBodyEdit', args: { role: 'user', turn: 2, seq: 6, sessionId: 's1' } },
    { method: 'saveBodyEdit', args: { token: 'u1', role: 'user', index: 3, turn: 2, seq: 6, texts: ['改过的输入'], sessionId: 's1' } },
    { method: 'regenBody', args: { guidance: '', sessionId: 's1' } }])
  await assert.rejects(service.editInput('s1', 1, '旧层'), /最新楼层/)
  await assert.rejects(service.editInput('s1', 2, '  '), /非空/)
  assert.equal(calls.filter(call => call.method === 'saveBodyEdit').length, 1)
})

test('resettle 只对最新楼层转调 retrySettlement；MVU 卡切换结果后 resettle 为真', async () => {
  const { client, calls } = loadClient({
    switchFloorResult: { switched: true, turn: 2, replySeq: 3, mvu: 'stale', view: { mode: 'story' } },
    retrySettlement: { view: { mode: 'story', rollbackTargetTurn: 2, canRegenerate: true, activity: { phase: 'pending', busy: false } } }
  })
  const service = serviceOf(client, { s1: eventWindow(story(2)) })
  const view = { mode: 'story', rollbackTargetTurn: 2, canRegenerate: true, tavernMvuRuntime: { owner: 'official' } }
  client.liveTavernView.setView('s1', view)
  assert.equal((await service.switchResult('s1', 2, 3)).resettle, true)
  client.liveTavernView.setView('s1', view)
  const result = await service.resettle('s1', 2)
  assert.deepEqual(calls.find(call => call.method === 'retrySettlement').args, { turn: 2, sessionId: 's1' })
  assert.equal(result.view.activity.phase, 'pending')
  await assert.rejects(service.resettle('s1', 1), /最新楼层/)
  client.liveTavernView.setView('s1', view)
  await assert.rejects(service.resettle('s1', 1), /最新楼层/)
  assert.equal(calls.filter(call => call.method === 'retrySettlement').length, 1, '非最新层不发请求')
  const failing = loadClient({ retrySettlement: { error: '当前最新正文没有失败的后台结算' } })
  const other = serviceOf(failing.client, { s1: eventWindow(story(2)) })
  failing.client.liveTavernView.setView('s1', view)
  await assert.rejects(other.resettle('s1', 2), /没有失败的后台结算/, '服务端拒绝原样传出')
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

test('subscribeRounds 的 receipts 投影每楼 MVU 回执：过滤镜像路径、白名单字段、截断与摘要；回执变化才回调', () => {
  const { client } = loadClient()
  const service = serviceOf(client, { s1: eventWindow(story(3).slice(4)) })
  const seen = []
  const stop = service.subscribeRounds('s1', rounds => seen.push(rounds))
  assert.deepEqual(plain(seen.at(-1).receipts), {}, '视图未读到时为空')
  const long = '长'.repeat(300)
  const bigObject = JSON.stringify(Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['键' + i, '值'.repeat(20)])))
  const bigArray = JSON.stringify(Array.from({ length: 40 }, (_, i) => '物品' + i))
  const receipt = {
    version: 1, status: 'partial', summary: '原因', diagnosticId: 'd1', secret: '不该出现',
    changes: [
      { operation: 'set', path: '/stat_data/金币', before: '30', after: '50', extra: 'x' },
      { operation: 'set', path: '/stat_data/日记', before: long, after: '短' },
      { operation: 'set', path: '/stat_data/背包', before: bigArray, after: '["剑"]' },
      { operation: 'insert', path: '/stat_data/状态', before: undefined, after: bigObject }
    ],
    sideEffects: [
      { operation: 'set', path: '/display_data/金币', before: '30', after: '50' },
      { operation: 'set', path: '/delta_data', before: '{}', after: '{"a":1}' },
      { operation: 'set', path: '/schema/x', before: '1', after: '2' },
      { operation: 'set', path: '/stat_data/联动', before: 1, after: { a: 1 } }
    ],
    failures: [{ operation: 'delta', path: '/好感', message: '未观察到对应变量变化' }, { command: '_.set(x)', message: '' }],
    runtimeDiagnostics: [{ level: 'info', message: '忽略' }, { level: 'warn', message: '警告1' }, { level: 'error', message: '错误2' }]
  }
  const view = { mode: 'story', rollbackTargetTurn: 3, settleStatus: 'done', settlementTurn: 3, activity: { phase: 'idle', busy: false } }
  client.liveTavernView.setView('s1', { ...view, mvuReceipts: [{ turn: 1, receipt: { status: 'updated', changes: [] } }, { turn: 3, receipt }, { turn: 2, receipt: { status: '奇怪', changes: [] } }] })
  const receipts = seen.at(-1).receipts
  assert.deepEqual(Object.keys(receipts), ['2', '3'], '只给窗口内的楼层（第 1 轮不在窗口）')
  assert.equal(receipts[2].status, 'unchanged', '未知状态按 unchanged')
  const got = plain(receipts[3])
  assert.equal(got.status, 'partial')
  assert.equal(got.summary, '原因')
  assert.equal(got.secret, undefined)
  assert.equal(got.diagnosticId, undefined)
  assert.deepEqual(got.changes[0], { path: '/stat_data/金币', operation: 'set', before: '30', after: '50' })
  assert.equal(got.changes[1].before.length, 120, '长文本截断到 120 字')
  assert.ok(got.changes[1].before.endsWith('…'))
  assert.equal(got.changes[2].before, '[40 项]', '过长数组给项数')
  assert.equal(got.changes[2].after, '["剑"]', '短值原样')
  assert.equal(got.changes[3].before, '（不存在）')
  assert.equal(got.changes[3].after, '{键0, 键1, 键2, 键3, 键4, …}（8 项）', '过长对象给键摘要')
  assert.deepEqual(got.sideEffects, [{ path: '/stat_data/联动', operation: 'set', before: '1', after: '{"a":1}' }], '镜像路径不进 sideEffects')
  assert.deepEqual(got.failures, [{ path: '/好感', operation: 'delta', message: '未观察到对应变量变化' }, { path: '_.set(x)', operation: '', message: '未知错误' }])
  assert.deepEqual(got.diagnostics, ['警告1', '错误2'])
  assert.deepEqual(got.counts, { changes: 4, sideEffects: 1, failures: 2 })
  const count = seen.length
  client.liveTavernView.setView('s1', { ...view, mvuReceipts: client.liveTavernView.getSnapshot('s1').view.mvuReceipts, posture: '无关字段' })
  assert.equal(seen.length, count, '回执与结算没变不回调')
  client.liveTavernView.setView('s1', { ...view, mvuReceipts: [{ turn: 3, receipt: { status: 'updated', changes: Array.from({ length: 80 }, (_, i) => ({ operation: 'set', path: '/p' + i, before: '0', after: '1' })) } }] })
  assert.equal(seen.length, count + 1)
  assert.equal(seen.at(-1).receipts[3].changes.length, 50, '每组最多 50 条')
  assert.equal(seen.at(-1).receipts[3].counts.changes, 80, 'counts 给过滤后的总数')
  assert.equal(seen.at(-1).receipts[2], undefined)
  stop()
})

test('subscribeRounds 的 settlement 投影视图 settleStatus / settlementTurn / settleError', () => {
  const { client } = loadClient()
  const service = serviceOf(client, { s1: eventWindow(story(2)) })
  const seen = []
  const stop = service.subscribeRounds('s1', rounds => seen.push(rounds))
  assert.equal(seen.at(-1).settlement, null, '视图未读到时为 null')
  const view = { mode: 'story', rollbackTargetTurn: 2, settlementTurn: 2, activity: { phase: 'idle', busy: false } }
  client.liveTavernView.setView('s1', { ...view, settleStatus: 'done', settleError: '旧错误' })
  assert.deepEqual(plain(seen.at(-1).settlement), { status: 'idle', turn: 2, error: null })
  client.liveTavernView.setView('s1', { ...view, settleStatus: 'done', activity: { phase: 'pending', busy: false } })
  assert.deepEqual(plain(seen.at(-1).settlement), { status: 'running', turn: 2, error: null }, '等待中也算运行')
  client.liveTavernView.setView('s1', { ...view, settleStatus: 'running', activity: { phase: 'running', busy: true } })
  assert.equal(seen.at(-1).settlement.status, 'running')
  client.liveTavernView.setView('s1', { ...view, settleStatus: 'error', settleError: '后台结算已中断，请重试结算。', activity: { phase: 'failed', busy: false } })
  assert.deepEqual(plain(seen.at(-1).settlement), { status: 'error', turn: 2, error: '后台结算已中断，请重试结算。' })
  client.liveTavernView.setView('s1', { ...view, settleStatus: 'error', settleError: null, settlementTurn: 0, activity: { phase: 'failed', busy: false } })
  assert.deepEqual(plain(seen.at(-1).settlement), { status: 'error', turn: null, error: '后台结算失败，请重试。' })
  stop()
})

test('resettle 的 guidance 透传到 retrySettlement；省略时不带（服务端沿用上次指导），无效参数不发请求', async () => {
  const { client, calls } = loadClient({ retrySettlement: () => ({ view: { mode: 'story', rollbackTargetTurn: 2, canRegenerate: true } }) })
  const service = serviceOf(client, { s1: eventWindow(story(2)) })
  const view = { mode: 'story', rollbackTargetTurn: 2, canRegenerate: true }
  client.liveTavernView.setView('s1', view)
  await service.resettle('s1', 2, { guidance: '这轮还没交付物品' })
  client.liveTavernView.setView('s1', view)
  await service.resettle('s1', 2, { guidance: '' })
  client.liveTavernView.setView('s1', view)
  await service.resettle('s1', 2, {})
  client.liveTavernView.setView('s1', view)
  await service.resettle('s1', 2)
  assert.deepEqual(calls.filter(call => call.method === 'retrySettlement').map(call => call.args), [
    { turn: 2, guidance: '这轮还没交付物品', sessionId: 's1' }, { turn: 2, guidance: '', sessionId: 's1' }, { turn: 2, sessionId: 's1' }, { turn: 2, sessionId: 's1' }])
  await assert.rejects(service.resettle('s1', 2, { guidance: 3 }), /guidance/)
  await assert.rejects(service.resettle('s1', 2, { guidance: 'x'.repeat(4001) }), /guidance/)
  await assert.rejects(service.resettle('s1', 2, 'text'), /guidance/)
  assert.equal(calls.filter(call => call.method === 'retrySettlement').length, 4)
})
