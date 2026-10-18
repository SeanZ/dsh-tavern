import { projectDisplayRuntimeState } from '../tavern-plugin/lib/domain/chat-session-state.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatJournalStore } from '../tavern-plugin/lib/domain/chat-journal-store.js'
import { createChatPersistence } from '../tavern-plugin/lib/domain/chat-persistence.js'
import { createDisplayRuntimeStore, displayRuntimeReceipt } from '../tavern-plugin/lib/domain/display-runtime-store.js'
import { sanitizeDomSnapshot, preserveCollectedDom, comparableDomSnapshot } from '../tavern-plugin/lib/domain/display-runtime-metadata.js'
import { createProfileDataStore } from '../tavern-plugin/lib/profile-data-store.js'

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'display-capture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const records = createChatJournalStore({ dataRoot: root })
  const persistence = createChatPersistence({ store: records })
  await persistence.write({ id: 'chat', sessionId: 'session', mode: 'story',
    backgroundConfigVersion: 1, conversationFeaturesVersion: 1, updatedAt: Date.now(),
    messages: Array.from({ length: 459 }, (_, turn) => ({ role: 'assistant', turn: turn + 1,
      text: `story ${turn}`, variables: { stat_data: { gold: 10, payload: 'history'.repeat(1000) } } })) })
  const source = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('  function cleanRuntimeUrl('), source.indexOf('  const tavernScriptHostAdapter ='))
  const hooks = { beforePatch: async () => {} }
  const displayRuntimeStore = createDisplayRuntimeStore({ store: createProfileDataStore({ dataRoot: root }) })
  const capturePersistence = { ...persistence }
  const capture = vm.runInNewContext(`(function(){${body};return captureDisplayRuntime})()`, {
    str: value => String(value ?? ''), groupOfMode: () => 'play',
    chatForSession: () => persistence.read('chat'), readSessionMap: async () => ({ session: 'chat' }),
    chatPersistence: capturePersistence,
    updateChat: (...args) => persistence.update(...args),
    patchChat: async (...args) => { await hooks.beforePatch(); return persistence.patch(...args) },
    displayRuntimeStore, displayRuntimeReceipt, sanitizeDomSnapshot, preserveCollectedDom, comparableDomSnapshot,
    projectDisplayRuntimeState, Date, Math, Object, Array, Number, JSON
  })
  return { records, persistence, capturePersistence, capture, hooks, root, displayRuntimeStore }
}

test('concurrent panels survive CAS retries, preserve valid undo and replay from disk', async t => {
  const { capture, persistence, records, root } = await harness(t)
  await persistence.update('chat', chat => {
    chat.rollbackUndo = { ready: true, storageRevision: chat._storageRevision + 1 }
    return chat
  })
  const before = await records.read('chat')
  await Promise.all([
    capture('session', 459, 0, { dom: 'first', panelId: 'one' }),
    capture('session', 459, 1, { dom: 'second', panelId: 'two' })
  ])
  const saved = await createChatJournalStore({ dataRoot: root }).read('chat')
  assert.equal(saved.messages[458].displayRuntime.frames.length, 2)
  assert.equal(saved.rollbackUndo.storageRevision, saved._storageRevision)
  assert.equal(saved.updatedAt, before.updatedAt)
  assert.equal(saved.messages[458].variables.stat_data.gold, 10)
})

test('a concurrent variable commit is retained and invalid undo is not revived', async t => {
  const { capture, persistence, records, hooks } = await harness(t)
  await persistence.update('chat', chat => {
    chat.rollbackUndo = { ready: true, storageRevision: chat._storageRevision + 1 }
    return chat
  })
  let raced = false
  hooks.beforePatch = async () => {
    if (raced) return
    raced = true
    await persistence.update('chat', chat => {
      chat.messages[458].variables.stat_data.gold = 20
      return chat
    })
  }
  await capture('session', 459, 0, { dom: 'status' })
  const saved = await records.read('chat')
  assert.equal(raced, true)
  assert.equal(saved.messages[458].variables.stat_data.gold, 20)
  assert.notEqual(saved.rollbackUndo.storageRevision, saved._storageRevision)
})

test('rollback during capture cannot recreate the removed turn', async t => {
  const { capture, persistence, records, hooks } = await harness(t)
  let raced = false
  hooks.beforePatch = async () => {
    if (raced) return
    raced = true
    await persistence.update('chat', chat => { chat.messages.pop(); return chat })
  }
  await assert.rejects(capture('session', 459, 0, { dom: 'old turn' }), /不存在第 459/)
  const saved = await records.read('chat')
  assert.equal(saved.messages.length, 458)
  assert.equal(saved.messages[457].displayRuntime, undefined)
})

test('layout evidence is bounded, persists through replay and deduplicates without touching variables', async t => {
  const { capture, records, root, displayRuntimeStore } = await harness(t)
  const layout = { mode: 'viewport', source: 'template', width: 390, height: 600, availableHeight: 600,
    roots: Array.from({ length: 20 }, () => ({ tag: 'BODY', height: 600, scrollHeight: Infinity, id: 'x'.repeat(200), arbitrary: 'discard' })), arbitrary: 'discard' }
  assert.equal((await capture('session', 459, 0, { layout })).captured, true)
  assert.equal((await capture('session', 459, 0, { layout })).captured, false)
  const saved = await createChatJournalStore({ dataRoot: root }).read('chat')
  // Layout is diagnostic evidence: kept beside the save, not in its history.
  assert.equal(saved.messages[458].displayRuntime.frames[0].layout, undefined)
  const evidence = (await displayRuntimeStore.read('chat', 459)).frames[0].layout
  assert.equal(evidence.height, 600)
  assert.equal(evidence.roots.length, 3)
  assert.equal(evidence.roots[0].id.length, 80)
  assert.equal(evidence.roots[0].scrollHeight, null)
  assert.equal(evidence.arbitrary, undefined)
  assert.equal(saved.messages[458].variables.stat_data.gold, 10)
  assert.equal((await capture('session', 459, 0, { layout: { ...layout, height: 400 } })).captured, true)
  assert.equal((await displayRuntimeStore.read('chat', 459)).frames[0].layout.height, 400)
})

import { createDisplayRuntimeCoalescer } from '../tavern-plugin/lib/domain/display-runtime-coalescer.js'

test('frame runtime reports are coalesced; first capture, errors and layout save at once', async () => {
  let clock = 0
  const timers = []
  const writes = []
  const coalescer = createDisplayRuntimeCoalescer({ intervalMs: 15000, now: () => clock,
    setTimer: (fn, ms) => { timers.push({ fn, at: clock + ms }); return timers.length }, clearTimer: () => {},
    write: async (sessionId, turn, partIndex, runtime) => { writes.push(runtime.dom); return { captured: true } } })
  const report = (dom, extra = {}) => coalescer.capture('s', 3, 0, { panelId: 'status', dom, ...extra })
  assert.equal((await report('a')).captured, true)
  clock = 1000; assert.equal((await report('b')).deferred, true)
  clock = 2000; assert.equal((await report('c')).deferred, true)
  clock = 3000; assert.equal((await report('d', { errors: [{ kind: 'error', message: 'boom' }] })).captured, true)
  clock = 4000; await report('e', { errors: [{ kind: 'error', message: 'boom' }] })
  assert.deepEqual(writes, ['a', 'd'])
  // One trailing write carries only the latest deferred report.
  clock = 18000; for (const timer of timers.splice(0)) timer.fn()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(writes, ['a', 'd', 'e'])
  clock = 40000; assert.equal((await report('f', { errors: [{ kind: 'error', message: 'boom' }] })).captured, true)
})

test('repainting frames update diagnostics without adding save revisions', async t => {
  const { capture, records, displayRuntimeStore } = await harness(t)
  await capture('session', 459, 0, { dom: 'frame 0', panelId: 'status' })
  const first = (await records.read('chat'))._storageRevision
  for (let i = 1; i <= 5; i++) assert.equal((await capture('session', 459, 0, { dom: 'frame ' + i, panelId: 'status' })).captured, true)
  const saved = await records.read('chat')
  assert.equal(saved._storageRevision, first)
  assert.deepEqual(saved.messages[458].displayRuntime, { version: 2, frames: [{ partIndex: 0, panelId: 'status', placement: 'message' }] })
  assert.equal((await displayRuntimeStore.read('chat', 459)).frames[0].dom, 'frame 5')
  // A new panel or an MVU read changes the receipt and is saved once.
  await capture('session', 459, 0, { dom: '', panelId: 'status', mvuViewUsed: true })
  assert.equal((await records.read('chat'))._storageRevision, first + 1)
})

test('显式空 DOM / partial / complete 的状态变化不被去重丢失，轻量包不覆盖同文档快照，receipt 只保留业务字段', async t => {
  const { capture, records, displayRuntimeStore } = await harness(t)
  const token = 'doc-a'
  const light = { panelId: 'status', dom: '', domSnapshot: { status: 'not_collected', documentToken: token } }
  assert.equal((await capture('session', 459, 0, light)).captured, true)
  assert.equal((await capture('session', 459, 0, light)).captured, false)
  const revision = (await records.read('chat'))._storageRevision
  const now = Date.now()
  assert.equal((await capture('session', 459, 0, { ...light, domSnapshot: { status: 'empty', documentToken: token, capturedAt: now } })).captured, true, 'not_collected → explicit empty 不被去重')
  assert.equal((await capture('session', 459, 0, { ...light, domSnapshot: { status: 'empty', documentToken: token, capturedAt: now, reports: 9, snapshots: 2 } })).captured, false, '递增计数不破坏去重')
  assert.equal((await capture('session', 459, 0, { ...light, dom: '<p>a</p>', domSnapshot: { status: 'partial', documentToken: token, capturedAt: now + 1, reasons: ['nodes'] } })).captured, true)
  assert.equal((await capture('session', 459, 0, { ...light, dom: '<p>a</p>', domSnapshot: { status: 'complete', documentToken: token, capturedAt: now + 2 } })).captured, true, 'partial → complete 同 dom 仍记录')
  // 同文档轻量包保留快照与其采集时间；换文档后清空。
  await capture('session', 459, 0, light)
  let stored = (await displayRuntimeStore.read('chat', 459)).frames[0]
  assert.equal(stored.dom, '<p>a</p>')
  assert.deepEqual(stored.domSnapshot, { status: 'complete', documentToken: token, capturedAt: now + 2 })
  await capture('session', 459, 0, { ...light, domSnapshot: { status: 'not_collected', documentToken: 'doc-b' } })
  stored = (await displayRuntimeStore.read('chat', 459)).frames[0]
  assert.equal(stored.dom, '')
  assert.equal(stored.domSnapshot.status, 'not_collected')
  const saved = await records.read('chat')
  assert.equal(saved._storageRevision, revision, 'DOM 证据变化不增加存档 revision')
  assert.deepEqual(saved.messages[458].displayRuntime, { version: 2, frames: [{ partIndex: 0, panelId: 'status', placement: 'message' }] })
  // MVU 入口语义不变：只带标志的包保留已有 DOM 证据并写一次 receipt。
  await capture('session', 459, 0, { ...light, dom: '<p>a</p>', domSnapshot: { status: 'complete', documentToken: 'doc-b', capturedAt: now + 3 } })
  await capture('session', 459, 0, { panelId: 'status', mvuViewUsed: true })
  stored = (await displayRuntimeStore.read('chat', 459)).frames[0]
  assert.equal(stored.dom, '<p>a</p>')
  assert.equal(stored.mvuViewUsed, true)
  assert.deepEqual((await records.read('chat')).messages[458].displayRuntime.frames, [{ partIndex: 0, panelId: 'status', placement: 'message', mvuViewUsed: true }])
  // 继承来的 MVU 标志不能把新协议包拉回旧 DOM：显式空 DOM 与换文档轻量包都按自身协议保存，receipt 标志仍为 true。
  await capture('session', 459, 0, { ...light, domSnapshot: { status: 'empty', documentToken: 'doc-b', capturedAt: now + 4 } })
  stored = (await displayRuntimeStore.read('chat', 459)).frames[0]
  assert.equal(stored.dom, '')
  assert.deepEqual(stored.domSnapshot, { status: 'empty', documentToken: 'doc-b', capturedAt: now + 4 })
  assert.equal(stored.mvuViewUsed, true)
  await capture('session', 459, 0, { ...light, domSnapshot: { status: 'not_collected', documentToken: 'doc-c' } })
  stored = (await displayRuntimeStore.read('chat', 459)).frames[0]
  assert.deepEqual(stored.domSnapshot, { status: 'not_collected', documentToken: 'doc-c' })
  assert.equal(stored.dom, '')
  assert.deepEqual((await records.read('chat')).messages[458].displayRuntime.frames, [{ partIndex: 0, panelId: 'status', placement: 'message', mvuViewUsed: true }])
})

test('首次 receipt 时不同面板并发采集：侧车保留同一回复世代的全部面板，旧世代面板在新回复时清除', async t => {
  const { capture, persistence, records, displayRuntimeStore } = await harness(t)
  const now = Date.now()
  await Promise.all([
    capture('session', 459, 0, { panelId: 'a', dom: '<p>a</p>', domSnapshot: { status: 'complete', documentToken: 'token-a', capturedAt: now } }),
    capture('session', 459, 1, { panelId: 'b', dom: '<p>b</p>', domSnapshot: { status: 'complete', documentToken: 'token-b', capturedAt: now } })
  ])
  assert.deepEqual((await records.read('chat')).messages[458].displayRuntime.frames.map(frame => frame.panelId), ['a', 'b'])
  assert.deepEqual((await displayRuntimeStore.read('chat', 459)).frames.map(frame => [frame.panelId, frame.dom]), [['a', '<p>a</p>'], ['b', '<p>b</p>']])
  // 新回复（回退重生成后 receipt 被清、updatedAt 变化）：旧世代的面板不再延续。
  await persistence.update('chat', chat => { delete chat.messages[458].displayRuntime; chat.updatedAt = Date.now() + 1000; return chat })
  await capture('session', 459, 0, { panelId: 'a', dom: '', domSnapshot: { status: 'not_collected', documentToken: 'token-a' } })
  assert.deepEqual((await displayRuntimeStore.read('chat', 459)).frames.map(frame => [frame.panelId, frame.dom, frame.domSnapshot.status]), [['a', '', 'not_collected']])
})

test('captures kept inline by older saves shrink to a receipt on the next capture', async t => {
  const { capture, persistence, records, displayRuntimeStore } = await harness(t)
  await persistence.update('chat', chat => {
    chat.messages[458].displayRuntime = { version: 1, sourceActivityAt: 1, frames: [{ partIndex: 1, panelId: 'old', placement: 'sidebar', dom: 'x'.repeat(5000) }] }
    return chat
  })
  await capture('session', 459, 0, { dom: 'new', panelId: 'status' })
  const saved = await records.read('chat')
  assert.deepEqual(saved.messages[458].displayRuntime.frames.map(frame => frame.panelId), ['status', 'old'])
  assert.equal(JSON.stringify(saved.messages[458].displayRuntime).includes('xxxx'), false)
  assert.equal((await displayRuntimeStore.read('chat', 459)).frames.length, 2)
})

test('旧文档已发出的诊断 RPC 晚完成时不覆盖同页面新快照',async t=>{
 const h=await harness(t);let release,entered;const gate=new Promise(resolve=>{release=resolve});const started=new Promise(resolve=>{entered=resolve});
 const read=h.capturePersistence.readDisplayRuntimeState;let blocked=false;
 h.capturePersistence.readDisplayRuntimeState=async(...args)=>{if(!blocked){blocked=true;entered();await gate;}return read(...args)};
 const report=(capturedAt,documentToken)=>({capturedAt,dom:documentToken,domSnapshot:{status:'complete',documentToken,capturedAt}});
 const old=h.capture('session',459,0,report(100,'old-document'));await started;
 await h.capture('session',459,0,report(200,'new-document'));release();await old;
 const frame=(await h.displayRuntimeStore.read('chat',459)).frames[0];
 assert.equal(frame.dom,'new-document');assert.equal(frame.capturedAt,200);assert.equal(frame.domSnapshot.documentToken,'new-document');
});
