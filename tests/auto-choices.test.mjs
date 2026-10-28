import test from 'node:test'
import assert from 'node:assert/strict'
import { createAutoChoices } from '../tavern-plugin/lib/domain/auto-choices.js'
import { applyTavernSettingsPatch, presentTavernSettings } from '../tavern-plugin/lib/domain/tavern-settings.js'
import { createSettingsHandlers } from '../tavern-plugin/lib/rpc/settings.js'
import { createPlayHandlers } from '../tavern-plugin/lib/rpc/play.js'

function harness() {
  const timers = new Set(), calls = [], errors = []
  let settings = { candidateAutoGenerate: true }
  const state = { messageId: 'reply-1', chat: {
    id: 'chat', mode: 'story', timeline: { branchId: 'branch' },
    messages: [{ role: 'assistant', turn: 1, ts: 100, text: 'A completed reply' }]
  } }
  const background = { busy: false, role: '', phase: 'idle' }
  let fail = false
  const scheduler = createAutoChoices({
    read: async () => structuredClone(state), preferences: async () => settings,
    activity: () => background,
    submit: async args => { calls.push(args); if (fail) throw new Error('submit failed') },
    defer: callback => { timers.add(callback); return callback }, clear: callback => timers.delete(callback),
    report: (...args) => errors.push(args)
  })
  const event = { sessionId: 'game', messageId: 'reply-1', turn: 1, reason: 'completed' }
  async function tick() {
    const batch = [...timers]; timers.clear()
    for (const callback of batch) callback()
    await new Promise(resolve => setImmediate(resolve))
  }
  return { scheduler, state, background, calls, errors, timers, event, tick,
    enable(value) { settings = { candidateAutoGenerate: value } }, fail() { fail = true } }
}

test('only live completed replies qualify: no catch-up, unfinished or disabled replies', async () => {
  const h = harness()
  await h.tick()
  assert.equal(h.calls.length, 0, 'opening a chat is not a completion event')
  for (const reason of ['running', 'error', 'aborted']) await h.scheduler.completed({ ...h.event, reason })
  await h.tick()
  assert.equal(h.calls.length, 0)
  h.enable(false)
  await h.scheduler.completed(h.event)
  h.enable(true)
  await h.scheduler.completed(h.event)
  await h.tick()
  assert.equal(h.calls.length, 0, 'turning it on later does not replay a reply completed while off')
  h.state.messageId = 'reply-2'; h.state.chat.messages[0].turn = 2
  await h.scheduler.completed({ ...h.event, messageId: 'reply-2', turn: 2, reason: 'max-tokens' })
  assert.equal(h.calls.length, 1, 'an idle completion submits at once, without waiting for a tick')
  assert.deepEqual(h.calls[0], { sessionId: 'game', messageId: 'reply-2', kind: 'candidate', guidance: '', requestId: h.calls[0].requestId })
  assert.match(h.calls[0].requestId, /^auto-choices-[a-f0-9]{64}$/)
  assert.equal(h.timers.size, 0)
})

test('settlement (even pending), background work, compaction and regeneration wait, then submit once', async () => {
  for (const mode of ['story', 'script']) {
    const h = harness(); h.state.chat.mode = mode
    h.background.role = 'settlement'; h.background.phase = 'pending'
    await h.scheduler.completed(h.event)
    await h.tick()
    assert.equal(h.calls.length, 0, 'pending settlement blocks with busy false')
    h.background.busy = true; h.background.phase = 'running'; h.background.role = 'worldbook'
    await h.tick()
    h.background.busy = false; h.background.phase = 'idle'
    h.state.chat.contextCompaction = { operation: { status: 'running' } }
    await h.tick()
    h.state.chat.contextCompaction = null; h.state.chat.regenInProgress = true
    await h.tick()
    assert.equal(h.calls.length, 0)
    h.state.chat.regenInProgress = false
    await h.tick()
    assert.equal(h.calls.length, 1)
    await h.tick()
    assert.equal(h.calls.length, 1)
    assert.equal(h.timers.size, 0)
  }
})

test('existing candidates or candidate tasks for the reply, including failed ones, are left alone', async () => {
  for (const existing of ['panel', 'queued', 'running', 'succeeded', 'failed', 'cancelled']) {
    const h = harness()
    if (existing === 'panel') h.state.chat.candidates = { messageId: 'reply-1' }
    else h.state.chat.taskMailbox = { tasks: { task: { kind: 'candidate', status: existing, input: { messageId: 'reply-1' } } } }
    await h.scheduler.completed(h.event)
    await h.tick()
    assert.equal(h.calls.length, 0, existing)
    assert.equal(h.timers.size, 0)
  }
})

test('card mode, greetings, empty replies and another turn never qualify', async () => {
  for (const change of [h => { h.state.chat.mode = 'card' },
    h => { h.state.chat.messages[0].greeting = true }, h => { h.state.chat.messages[0].text = '' },
    h => { h.state.chat.messages[0].turn = 0 }]) {
    const h = harness(); change(h)
    await h.scheduler.completed(h.event)
    await h.tick()
    assert.equal(h.calls.length, 0)
    assert.equal(h.timers.size, 0)
  }
})

test('turning it off, edits, branches, newer replies and cancellation drop a waiting reply', async () => {
  for (const change of [h => h.enable(false), h => { h.state.chat.messages[0].text = 'edited' },
    h => { h.state.chat.timeline.branchId = 'other' },
    h => { h.state.messageId = 'new-message' }, h => h.scheduler.cancel('game'), h => h.scheduler.cancelAll()]) {
    const h = harness()
    h.state.chat.contextCompaction = { operation: { status: 'running' } }
    await h.scheduler.completed(h.event)
    change(h)
    await h.tick()
    h.state.chat.contextCompaction = null
    await h.scheduler.completed(h.event)
    await h.tick()
    assert.equal(h.calls.length, 0)
    assert.equal(h.timers.size, 0)
  }
})

test('duplicate completions, a failed submission and disposal never submit twice or retry', async () => {
  const h = harness(); h.fail()
  await Promise.all([h.scheduler.completed(h.event), h.scheduler.completed(h.event)])
  await h.tick(); await h.tick()
  await h.scheduler.completed(h.event); await h.tick()
  assert.equal(h.calls.length, 1)
  assert.equal(h.errors.length, 1)
  const disposed = harness()
  disposed.state.chat.regenInProgress = true
  await disposed.scheduler.completed(disposed.event)
  disposed.scheduler.dispose()
  await disposed.tick()
  assert.equal(disposed.calls.length, 0)
  assert.equal(disposed.timers.size, 0)
})

test('a cancellation during the eligibility read cannot re-arm the reply', async () => {
  let release
  const settings = new Promise(resolve => { release = resolve })
  const timers = []
  const scheduler = createAutoChoices({ preferences: () => settings, read: async () => ({}),
    activity: () => ({}), submit: () => assert.fail('cancelled reply submitted'), defer: callback => timers.push(callback) })
  const pending = scheduler.completed({ sessionId: 'game', messageId: 'reply', turn: 1, reason: 'completed' })
  scheduler.cancel('game')
  release({ candidateAutoGenerate: true })
  await pending
  assert.equal(timers.length, 0)
})

test('the setting is off by default, strictly boolean, and leaves the other candidate preference alone', () => {
  assert.equal(presentTavernSettings({}).candidateAutoGenerate, false)
  assert.equal(presentTavernSettings({ candidateAutoGenerate: 'true' }).candidateAutoGenerate, false)
  assert.throws(() => applyTavernSettingsPatch({}, { candidateAutoGenerate: 'true' }), /自动生成候选项/)
  const saved = applyTavernSettingsPatch({ candidateDismissMode: 'after-fill', custom: 7 }, { candidateAutoGenerate: true })
  assert.equal(saved.custom, 7)
  assert.deepEqual([presentTavernSettings(saved).candidateAutoGenerate, presentTavernSettings(saved).candidateDismissMode], [true, 'after-fill'])
  assert.equal(presentTavernSettings(applyTavernSettingsPatch(saved, { candidateAutoGenerate: false })).candidateAutoGenerate, false)
})

test('requests: settings save it, turning it off drops waiting replies, manual and edit requests supersede it', async () => {
  const cancelled = []
  const autoChoices = { cancel: id => cancelled.push(id), cancelAll: () => cancelled.push('*') }
  let document = {}
  const readTavernSettings = async () => presentTavernSettings(document)
  const settings = createSettingsHandlers({ autoChoices, readTavernSettings,
    updateTavernSettings: async patch => { document = applyTavernSettingsPatch(document, patch); return readTavernSettings() } })
  assert.equal((await readTavernSettings()).candidateAutoGenerate, false)
  assert.equal((await settings.updateTavernSettings({ patch: { candidateAutoGenerate: true } })).settings.candidateAutoGenerate, true)
  assert.deepEqual(cancelled, [])
  await settings.updateTavernSettings({ patch: { candidateAutoGenerate: false } })
  assert.deepEqual(cancelled, ['*'])
  const submitted = []
  const play = createPlayHandlers({ autoChoices, str: value => value == null ? '' : String(value),
    candidateTasks: { submit: async args => { submitted.push(args); return {} } },
    bodyEditor: { read: async () => ({ token: 't' }) } })
  await play.submitTask({ sessionId: 'game', kind: 'candidate', messageId: 'reply' })
  await play.getBodyEdit({ sessionId: 'game' })
  assert.deepEqual(cancelled, ['*', 'game', 'game'])
  assert.equal(submitted.length, 1)
})
