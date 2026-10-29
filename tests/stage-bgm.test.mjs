// The BGM player (modules/stage-bgm.js): one owner across chat and stage, 导演选曲 / manual picks, per-game memory.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')
const { createStageBgm, stageBgmStep, stageBgmSearch, TAVERN_BGM_STORAGE } = vm.runInNewContext(read('tavern-plugin/src/client/modules/stage-bgm.js') +
  '; ({ createStageBgm, stageBgmStep, stageBgmSearch, TAVERN_BGM_STORAGE })')
const tick = () => new Promise(resolve => setImmediate(resolve))

const track = (id, name = id.toUpperCase()) => ({ key: 'P/' + id, ref: { packId: 'P', kind: 'music', assetId: id }, identity: 'P:music:' + id + ':h', name, pack: 'Pack', url: 'lease-' + id })
const state = (cue, data = {}, reader = { mode: 'live' }) => ({ data: { enabled: true, musicEnabled: true, card: { imageUrl: 'card-a' }, music: cue && track(cue), ...data }, reader })
function storage(initial = {}) { const map = new Map(Object.entries(initial)); return { getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), map } }
function fakeSessions(initial) {
  const states = { ...initial }, listeners = new Map()
  return { getSnapshot: id => states[id] || { data: null, reader: { mode: 'refresh' } },
    subscribe(id, fn) { if (!listeners.has(id)) listeners.set(id, new Set()); listeners.get(id).add(fn); return () => listeners.get(id).delete(fn) },
    set(id, patch) { states[id] = { ...states[id], ...patch }; listeners.get(id)?.forEach(fn => fn()) },
    data(id, patch) { this.set(id, { data: { ...states[id].data, ...patch } }) } }
}
function fakeMusic() {
  const calls = []; let identity = null, current = '', paused = true, error = null
  return { calls, fail: new Set(),
    get: () => ({ identity, current, paused, error }),
    play(url, snap, id) { calls.push(['play', id, url, snap]); identity = id; current = url; paused = false; error = this.fail.has(url) ? 'Music fetch failed: 404' : null; return Promise.resolve() },
    pause() { calls.push(['pause']); paused = true },
    resume() { calls.push(['resume']); paused = false },
    trim() {},
    stop(snap = true) { calls.push(['stop', snap]); identity = null; current = ''; paused = true; error = null } }
}
function harness({ saved = {}, tracks = ['a', 'b', 'c'], sessions = fakeSessions({ s: state('a') }) } = {}) {
  const music = fakeMusic(), local = storage(saved), reads = []
  let time = 0
  const bgm = createStageBgm({ music, sessions, storage: local, now: () => ++time,
    read: async id => { reads.push(id); return { tracks: tracks.map(id => track(id)) } } })
  return { bgm, music, local, reads, sessions, list: tracks }
}
const plays = music => music.calls.filter(call => call[0] === 'play').map(call => call[1])

test('list order: prev / next wrap and enter from outside the list; search keeps order', () => {
  const tracks = ['a', 'b', 'c'].map(id => track(id))
  assert.equal(stageBgmStep(tracks, 'P/a', 1).key, 'P/b')
  assert.equal(stageBgmStep(tracks, 'P/c', 1).key, 'P/a', 'next wraps')
  assert.equal(stageBgmStep(tracks, 'P/a', -1).key, 'P/c', 'prev wraps')
  assert.equal(stageBgmStep(tracks, 'G/x', 1).key, 'P/a', 'a track outside the list: next enters at the top')
  assert.equal(stageBgmStep(tracks, 'G/x', -1).key, 'P/c')
  assert.equal(stageBgmStep([], 'P/a', 1), null)
  assert.deepEqual(stageBgmSearch([track('a', 'Rain Walk'), track('b', '夜'), track('c', 'rainy day')], 'RAIN').map(item => item.key), ['P/a', 'P/c'])
})

test('the director\'s stop fades; skipping and leaving the game stop at once; skipping snaps a new track in', async () => {
  const { bgm, music, sessions } = harness()
  bgm.activate('s'); await tick()
  sessions.data('s', { music: null })
  assert.deepEqual(music.calls.at(-1), ['stop', false])
  sessions.set('s', { reader: { mode: 'skip' } }); sessions.data('s', { music: track('b') })
  assert.deepEqual(music.calls.at(-1).slice(0, 4), ['play', 'P:music:b:h', 'lease-b', true])
  sessions.data('s', { music: null })
  assert.deepEqual(music.calls.at(-1), ['stop', true])
  sessions.set('s', { reader: { mode: 'live' } }); sessions.data('s', { music: track('a') })
  bgm.activate(null)
  assert.deepEqual(music.calls.at(-1), ['stop', true])
})

test('per-game memory: the mode, the pick and pause survive a reload of that game; another game starts following', async () => {
  const sessions = fakeSessions({ s: state('a'), t: state('b') })
  const first = harness({ sessions })
  first.bgm.activate('s'); await tick()
  first.bgm.pick('P/c'); await tick()
  const saved = JSON.parse(first.local.map.get(TAVERN_BGM_STORAGE))
  assert.deepEqual(Object.keys(saved), ['s']); assert.equal(saved.s.follow, false); assert.equal(saved.s.manual.key, 'P/c')
  first.bgm.activate('t'); await tick()
  assert.equal(first.bgm.get().follow, true, 'a new game starts in auto')
  assert.equal(plays(first.music).at(-1), 'P:music:b:h')
  first.bgm.activate('s'); await tick()
  assert.equal(first.bgm.get().follow, false); assert.equal(plays(first.music).at(-1), 'P:music:c:h', 'switching back restores the pick')

  const reload = harness({ saved: Object.fromEntries(first.local.map), sessions })
  reload.bgm.activate('s'); await tick()
  assert.deepEqual(plays(reload.music), ['P:music:c:h'], 'the pick plays, not the director\'s track')
  reload.bgm.follow(true); await tick()
  assert.equal(reload.local.map.get(TAVERN_BGM_STORAGE), '{}', 'auto and playing is the default and is not stored')

  const gone = harness({ saved: Object.fromEntries(first.local.map), tracks: ['a', 'b'], sessions })
  gone.bgm.activate('s'); await tick()
  assert.equal(gone.bgm.get().follow, true, 'a pick that left the card\'s packs hands back to the director')
  assert.deepEqual(plays(gone.music), ['P:music:a:h'])

  const many = harness({ sessions: fakeSessions(Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['s' + i, state('a')]))) })
  for (let i = 0; i < 40; i++) { many.bgm.activate('s' + i); await tick(); many.bgm.pause(true) }
  const kept = JSON.parse(many.local.map.get(TAVERN_BGM_STORAGE))
  assert.ok(Object.keys(kept).length <= 32 && kept.s39, 'only the most recent games are kept')
})
