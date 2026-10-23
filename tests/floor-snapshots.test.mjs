import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createProfileDataStore } from '../tavern-plugin/lib/profile-data-store.js'
import { createFloorSnapshots, FLOOR_SNAPSHOT_HTML_LIMIT } from '../tavern-plugin/lib/story/floor-snapshots.js'

// The real profile data store on a temporary directory: the files a restart reads back.
async function fixture(t, links = { 'session-a': 'chat-a', 'session-b': 'chat-b' }) {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-floor-snapshots-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let clock = 1000
  const open = () => createFloorSnapshots({ store: createProfileDataStore({ dataRoot: root }), chatIdFor: async id => links[id], now: () => ++clock })
  return { root, open, snapshots: open() }
}

test('写入后回读：按故事轮返回 HTML 与元数据，重启（新实例）后仍可读', async t => {
  const { root, open, snapshots } = await fixture(t)
  const saved = await snapshots.save({ sessionId: 'session-a', turn: 3, reply: '42', html: '<div class="mes">第三轮</div>', truncated: false })
  assert.deepEqual(saved, { saved: true, snapshot: { turn: 3, reply: '42', truncated: false, capturedAt: 1001 } })
  await snapshots.save({ sessionId: 'session-a', turn: 5, reply: '57', html: '<p>第五轮</p>', truncated: true })
  const reread = await open().read({ sessionId: 'session-a' })
  assert.deepEqual(reread, { snapshots: {
    3: { turn: 3, reply: '42', truncated: false, capturedAt: 1001, html: '<div class="mes">第三轮</div>' },
    5: { turn: 5, reply: '57', truncated: true, capturedAt: 1002, html: '<p>第五轮</p>' } } })
  assert.deepEqual(Object.keys((await snapshots.read({ sessionId: 'session-a', turns: [5, 9] })).snapshots), ['5'])
  // Stored beside the save, one versioned record per floor.
  const record = JSON.parse(await readFile(path.join(root, 'floor-snapshots', 'chat-a', '3.json'), 'utf8'))
  assert.equal(record.version, 1)
  // Another game reads only its own.
  assert.deepEqual(await snapshots.read({ sessionId: 'session-b' }), { snapshots: {} })
})

test('幂等：同一来源与内容再写不改文件；换了来源回复（重新生成）覆盖旧快照', async t => {
  const { snapshots } = await fixture(t)
  const input = { sessionId: 'session-a', turn: 2, reply: '10', html: '<b>旧</b>' }
  assert.equal((await snapshots.save(input)).saved, true)
  const again = await snapshots.save(input)
  assert.deepEqual(again, { saved: false, snapshot: { turn: 2, reply: '10', truncated: false, capturedAt: 1001 } })
  assert.equal((await snapshots.save({ ...input, reply: '19', html: '<b>新</b>' })).saved, true)
  assert.deepEqual((await snapshots.read({ sessionId: 'session-a' })).snapshots[2], { turn: 2, reply: '19', truncated: false, capturedAt: 1002, html: '<b>新</b>' })
  // Concurrent writes of one game serialize; the last one wins whole.
  await Promise.all([1, 2, 3].map(n => snapshots.save({ ...input, reply: 'r' + n, html: '<i>' + n + '</i>' })))
  assert.equal((await snapshots.read({ sessionId: 'session-a' })).snapshots[2].html, '<i>3</i>')
})

test('旧存档兼容：从未写过快照的游戏读出空表，损坏或未知版本的文件被忽略', async t => {
  const { root, snapshots } = await fixture(t)
  assert.deepEqual(await snapshots.read({ sessionId: 'session-a' }), { snapshots: {} })
  const store = createProfileDataStore({ dataRoot: root })
  await store.writeJson('floor-snapshots/chat-a/4.json', { version: 2, turn: 4, reply: 'x', html: '<p/>' })
  await store.writeJson('floor-snapshots/chat-a/6.json', { version: 1, turn: 7, reply: 'x', html: '<p/>' })
  await store.writeJson('floor-snapshots/chat-a/notes.json', { version: 1 })
  assert.deepEqual(await snapshots.read({ sessionId: 'session-a' }), { snapshots: {} })
})

test('拒绝无效写入：未知会话、轮次、来源、类型与超限内容；删除游戏时一并清掉', async t => {
  const { root, snapshots } = await fixture(t)
  const ok = { sessionId: 'session-a', turn: 1, reply: '1', html: '<p/>' }
  await assert.rejects(snapshots.save({ ...ok, sessionId: 'missing' }), /找不到当前存档/)
  await assert.rejects(snapshots.save({ ...ok, turn: 0 }), /轮次/)
  await assert.rejects(snapshots.save({ ...ok, reply: ' ' }), /来源回复/)
  await assert.rejects(snapshots.save({ ...ok, html: null }), /HTML/)
  await assert.rejects(snapshots.save({ ...ok, truncated: 'yes' }), /布尔值/)
  await assert.rejects(snapshots.save({ ...ok, html: 'x'.repeat(FLOOR_SNAPSHOT_HTML_LIMIT + 1) }), /截断/)
  await assert.rejects(snapshots.read({ sessionId: 'session-a', turns: ['a'] }), /轮次/)
  await snapshots.save(ok)
  await snapshots.save({ ...ok, turn: 2 })
  await snapshots.removeChat('chat-a')
  assert.deepEqual(await readdir(path.join(root, 'floor-snapshots', 'chat-a')), [])
  assert.deepEqual(await snapshots.read({ sessionId: 'session-a' }), { snapshots: {} })
})

test('只保留最近 200 层：更早楼层的快照被删除', async t => {
  const { snapshots } = await fixture(t)
  for (let turn = 1; turn <= 203; turn++) await snapshots.save({ sessionId: 'session-a', turn, reply: String(turn), html: '<p>' + turn + '</p>' })
  const turns = Object.keys((await snapshots.read({ sessionId: 'session-a' })).snapshots).map(Number)
  assert.equal(turns.length, 200)
  assert.equal(Math.min(...turns), 4)
})

test('RPC 快照使用真实磁盘存储，删除后冷读为空', async t => {
  const { createStoryHandlers } = await import('../tavern-plugin/lib/rpc/story.js')
  const { snapshots, open } = await fixture(t)
  const rpc = createStoryHandlers({ snapshots })
  assert.equal((await rpc.saveFloorSnapshot({ sessionId: 'session-a', turn: 3, reply: 'r1', html: '<p>正文</p>' })).saved, true)
  const cold = createStoryHandlers({ snapshots: open() })
  assert.equal((await cold.getFloorSnapshots({ sessionId: 'session-a' })).snapshots[3].html, '<p>正文</p>')
  await snapshots.removeChat('chat-a')
  assert.deepEqual(await cold.getFloorSnapshots({ sessionId: 'session-a' }), { snapshots: {} })
})
