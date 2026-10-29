import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { tavernCastCharacter } from '../tavern-plugin/lib/domain/cast-stage-state.js'
import { createStagePerformancePlayback } from '../tavern-plugin/lib/domain/stage-performance-playback.js'

const source = readFileSync(new URL('../tavern-plugin/src/client/modules/stage-runtime.js', import.meta.url), 'utf8')
const { createStageRuntimeStore, createStageRuntimeSessions } = vm.runInNewContext(source + '; ({createStageRuntimeStore, createStageRuntimeSessions})', { AbortController, createStagePerformancePlayback })
const feature = readFileSync(new URL('../tavern-plugin/src/client/features/stage-runtime.js', import.meta.url), 'utf8')
const project = vm.runInNewContext(feature.slice(0, feature.indexOf('function watchStageRuntime')) + '; stageRuntimeScene', { tavernCastCharacter })
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const data = (name = 'Nora') => ({ enabled: true, card: { name, imageUrl: 'card' }, cast: [{ name, aliases: ['Reader'], sprites: { joy: 'joy', neutral: 'calm' } }], stage: { figures: [{ speaker: name, emotion: 'joy' }] }, turns: [] })
const copy = value => JSON.parse(JSON.stringify(value))

function fixture() {
  const reads = [], changes = []
  const store = createStageRuntimeStore({ read(signal) { const task = deferred(); reads.push({ ...task, signal }); return task.promise }, project, changed: () => changes.push(store.getSnapshot()) })
  return { store, reads, changes }
}

test('context withdrawal aborts and clears; late responses after reset or disposal cannot publish', async () => {
  const { store, reads } = fixture()
  let pending = store.refresh(); await tick(); reads[0].resolve(data()); await pending
  pending = store.refresh(); await tick(); store.refresh(true)
  assert.equal(reads[1].signal.aborted, true); assert.equal(store.getSnapshot().scene, null)
  reads[1].resolve(data('Old branch')); await tick(); reads[2].resolve(data('Other card')); await pending
  assert.equal(store.getSnapshot().data.card.name, 'Other card')
  pending = store.refresh(); await tick(); store.dispose(); reads[3].resolve(data('Late')); await pending
  assert.equal(store.getSnapshot().data, null); assert.equal(reads[3].signal.aborted, true)
})

test('session owner survives UI remount, isolates sessions, replaces bindings and releases subscriptions', async () => {
  let selected = 'a', listener, stopped = 0, notifications = 0
  const bindings = { a: {}, b: {} }, watches = new Map(), reads = []
  const sessions = { binding: id => bindings[id], list: { getSnapshot: () => ({ current: selected, byId: Object.fromEntries(Object.keys(bindings).map(id => [id, { id }])) }), subscribe: fn => { listener = fn; return () => { listener = null } } } }
  const owner = createStageRuntimeSessions({ read: async id => { reads.push(id); return data(id) }, project, watch: (id, binding, wake) => { watches.set(id, wake); return () => { stopped++; watches.delete(id) } } })
  const stop = owner.start(sessions); await tick()
  const first = owner.getSnapshot('a'), unsubscribe = owner.subscribe('a', () => notifications++)
  unsubscribe(); const unmount = owner.subscribe('a', () => notifications++)
  assert.equal(owner.getSnapshot('a'), first); assert.deepEqual(reads, ['a'])
  selected = 'b'; listener(); await tick()
  assert.equal(owner.getSnapshot('b').data.card.name, 'b'); assert.equal(owner.getSnapshot('a'), first)
  selected = 'a'; listener(); await tick(); assert.deepEqual(reads, ['a', 'b'])
  watches.get('a')(); await tick(); assert.ok(notifications > 0)
  bindings.a = {}; listener(); await tick(); assert.equal(stopped, 1)
  delete bindings.b; listener(); assert.equal(owner.getSnapshot('b').data, null); assert.equal(stopped, 2)
  unmount(); stop(); assert.equal(stopped, 3); assert.equal(listener, null); assert.equal(watches.size, 0)
  assert.equal(owner.getSnapshot('a').data, null)
})

const turn = (key, texts, performances = []) => ({ turn: 2, key, pages: texts.map(text => ({ kind: 'narration', text })), performances })
const withTurns = (...turns) => ({ ...data(), turns, music: { name: 'theme', url: 'theme.wav' } })
async function accept(store, reads, value) { const pending = store.refresh(); await tick(); reads.at(-1).resolve(value); await pending }

function playerFixture() {
  let value = withTurns(turn('a', ['first', 'second', 'third'], [{ at: 1, op: 'screen.play', effect: 'shake-1' }, { at: 2, op: 'screen.play', effect: 'shake-1' }]))
  let listener, reading = true
  const bindings = { a: {} }, timers = new Map(), log = []
  let next = 0
  const sessions = { binding: id => bindings[id], list: { getSnapshot: () => ({ current: 'a', byId: Object.fromEntries(Object.keys(bindings).map(id => [id, { id }])) }), subscribe: fn => { listener = fn; return () => {} } } }
  const owner = createStageRuntimeSessions({ read: async () => copy(value), project, watch: (id, binding, wake) => { owner.wake = wake; return () => {} } })
  const voices = []
  const view = { schedule: (fn, delay) => { const id = ++next; timers.set(id, { fn, delay }); return id }, cancel: id => timers.delete(id),
    animate: (event, id) => { log.push('play ' + event.at); return { cancel: () => log.push('cancel ' + event.at), finished: new Promise(() => {}) } },
    speech: { on: () => reading, speak: beat => { const voice = { beat, ...deferred() }; voices.push(voice); log.push('say ' + beat.text); return voice.promise }, stop: () => log.push('hush') },
    release: () => log.push('release') }
  return { owner, view, timers, log, voices, sessions, bindings, relist: () => listener(), set: next => { value = next }, setReading: on => { reading = on },
    async run(delay) { await tick(); for (const [id, timer] of [...timers]) if (delay === undefined || timer.delay === delay) { timers.delete(id); timer.fn() } await tick() },
    async wake(reset) { await owner.wake(reset); await tick() } }
}

test('an attached view plays the session page once; closing releases everything and reopening restores silently', async () => {
  const h = playerFixture()
  h.owner.start(h.sessions); await tick()
  let detach = h.owner.attach('a', h.view); await h.run()
  assert.deepEqual(h.log, ['say first'], 'opening shows and reads the page but never replays its one-shot; music is the BGM player\'s')
  h.log.length = 0
  h.owner.page('a', 1); await h.run(1000)
  assert.deepEqual(h.log, ['say second', 'play 2'])
  h.owner.page('a', 0); h.owner.page('a', 1); await h.run()
  assert.equal(h.log.filter(line => line === 'play 1').length, 0, 'rapid paging cancels the page it left')
  h.log.length = 0
  h.owner.page('a', 0)
  assert.deepEqual(h.log, ['cancel 2', 'say first'], 'leaving a page cancels its running one-shot')
  h.log.length = 0
  detach()
  assert.deepEqual(h.log, ['release', 'hush'], 'closing releases what the view holds (a plugin\'s music); the stage\'s BGM is not the view\'s')
  await h.run(); assert.equal(h.timers.size, 0, 'no timer survives closing')
  h.log.length = 0
  detach = h.owner.attach('a', h.view); await h.run()
  assert.equal(h.owner.getSnapshot('a').reader.index, 0, 'reopening returns to the page')
  assert.deepEqual(h.log, ['say first'], 'the dwell left pending at close does not play after reopening')
  h.log.length = 0
  h.set(withTurns(turn('b', ['arrives'], [{ at: 1, op: 'screen.play', effect: 'shake-1' }]))); await h.wake()
  await h.run(0)
  assert.deepEqual(h.log, ['say arrives', 'play 1'], 'a new body plays its first page live')
  h.log.length = 0
  await h.wake(); await h.run()
  assert.deepEqual(h.log, [], 'an identical snapshot neither replays nor rereads')
  h.set(withTurns(turn('b', ['regenerated']))); await h.wake()
  assert.deepEqual(h.log, ['say regenerated'])
  h.log.length = 0
  h.owner.page('a', 0, 'skip'); await h.run()
  assert.deepEqual(h.log, ['cancel 1', 'hush'], 'skip cancels the running one-shot, stops reading and plays nothing')
  h.log.length = 0
  h.owner.page('a', 0, 'refresh'); await h.run()
  assert.deepEqual(h.log, ['say regenerated'])
  h.bindings.a = {}; h.relist(); await tick()
  assert.deepEqual(h.log, ['say regenerated', 'release', 'hush'], 'replacing the binding releases the attached player')
  detach(); h.owner.page('a', 0); await h.run(); assert.deepEqual(h.log.filter(line => line.startsWith('say') || line.startsWith('play')), ['say regenerated'])
})

test('auto paging walks a page\'s cards: each waits its reading time, a voiced one turns at its share, the last waits the voice', async () => {
  const h = playerFixture()
  let cards = null, progress = null
  const view = { ...h.view, card: () => cards && { ...cards.list[cards.at], at: cards.at, last: cards.at === cards.list.length - 1 },
    nextCard: () => { h.log.push('card ' + (cards.at + 1)); cards.at++ }, speech: { ...h.view.speech, progress: () => progress } }
  h.owner.start(h.sessions); await tick()
  cards = { at: 0, list: [{ text: 'first card', share: .4 }, { text: 'last', share: 1 }] }
  const detach = h.owner.attach('a', view); await h.run()
  h.owner.setAuto('a', true); await tick()
  const delays = () => [...h.timers.values()].map(timer => timer.delay).filter(delay => delay !== 1000)
  assert.deepEqual(delays(), [80], 'a voiced card follows the voice')
  progress = .3; await h.run(80)
  assert.deepEqual(delays(), [80], 'not yet at its share')
  progress = .45; await h.run(80)
  assert.equal(cards.at, 1, 'the card turned at its share of the voice'); assert.equal(h.owner.getSnapshot('a').reader.index, 0, 'the page did not turn')
  h.owner.sync('a'); await tick()
  assert.deepEqual(delays(), [], 'the last card waits for the voice to end')
  h.voices[0].resolve(true); await tick()
  assert.deepEqual(delays(), [400], 'then autoWait')
  await h.run(400)
  assert.equal(h.owner.getSnapshot('a').reader.index, 1, 'after its last card the page turns')
  assert.equal(h.voices.length, 2, 'a card turn never restarts the page\'s voice')
  // silent: every card waits its own reading time
  h.setReading(false); cards = { at: 0, list: [{ text: 'x'.repeat(40), share: .5 }, { text: 'y', share: 1 }] }; h.owner.sync('a'); await tick()
  assert.deepEqual(delays(), [3200])
  await h.run(3200); h.owner.sync('a'); await tick()
  assert.equal(cards.at, 1); assert.deepEqual(delays(), [1500])
  await h.run(1500)
  assert.equal(h.owner.getSnapshot('a').reader.index, 2)
  // the last page's cards are read too; auto stops after its last card
  cards = { at: 0, list: [{ text: 'one', share: .5 }, { text: 'two', share: 1 }] }; h.owner.sync('a'); await tick()
  await h.run(1500); h.owner.sync('a'); await tick()
  assert.equal(cards.at, 1); assert.deepEqual(delays(), [], 'the last card of the last page stays')
  h.owner.setAuto('a', false); detach()
})

test('source adapter resets on changed authority, keeps refreshes read-only and removes every watch', () => {
  let view = { chatId: 'a', card: { path: 'card' }, settlementTurn: 1 }, onView, onSession, running = false, cleared = 0
  const refreshes = [], events = new Map(), stops = []
  const subscribe = fn => { stops.push(fn); return () => { cleared++ } }
  const watch = vm.runInNewContext(feature.slice(feature.indexOf('function watchStageRuntime'), feature.indexOf('const tavernStageRuntime')) + '; watchStageRuntime', {
    liveTavernView: { select: () => ({ getSnapshot: () => ({ view }), subscribe: fn => { onView = fn; return subscribe(fn) } }) },
    tavernCoordination: { subscribe: (_, fn) => subscribe(fn) }, tavernSessionSignals: { subscribe: (_, channel, fn) => { assert.equal(channel, 'cast'); return subscribe(fn) } },
    document: { hidden: false }, window: { addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name), setInterval: () => 1, clearInterval: () => { cleared++ } }
  })
  const stop = watch('a', { session: { getSnapshot: () => ({ running }), subscribe: fn => { onSession = fn; return subscribe(fn) } } }, reset => refreshes.push(Boolean(reset)))
  onView(); view = { ...view, settlementTurn: 2 }; onView(); assert.deepEqual(refreshes, [false, false])
  view = { ...view, regeneratedDshTurns: { 2: 4 }, suppressedDshTurns: [4] }; onView(); assert.equal(refreshes.at(-1), false)
  view = { ...view, suppressedDshTurns: [2, 4] }; onView(); assert.equal(refreshes.at(-1), true)
  running = true; onSession(); assert.equal(refreshes.at(-1), false)
  stop(); assert.equal(cleared, 5); assert.equal(events.size, 0)
})
