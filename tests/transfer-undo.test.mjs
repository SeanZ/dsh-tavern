import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { createTransferUndo } from '../tavern-plugin/lib/domain/transfer-undo.js'

// In-memory stand-in for the resource store: files is a Map keyed by "kind:path".
function fakeStore(initial = {}) {
  const files = new Map(Object.entries(initial))
  const removed = []
  const failures = new Map()
  return {
    files,
    removed,
    failRemove(key, message) { failures.set(key, message) },
    hashOf(kind, path) {
      const content = files.get(kind + ':' + path)
      if (content === undefined) return null
      return createHash('sha256').update(content).digest('hex')
    },
    remove(kind, path) {
      const key = kind + ':' + path
      if (failures.has(key)) throw new Error(failures.get(key))
      files.delete(key)
      removed.push(key)
    },
  }
}

const sha = content => createHash('sha256').update(content).digest('hex')

function record(kind, path, content, title = path) {
  return { kind, title, path, sha256: sha(content) }
}

test('全部匹配时逐个删除，并返回删除顺序', async () => {
  const store = fakeStore({ 'card:cards/a.json': 'A', 'worldbook:worldbooks/b.json': 'B', 'preset:presets/c.json': 'C' })
  const { undo } = createTransferUndo({ hashOf: store.hashOf, remove: store.remove })
  const result = await undo([
    record('card', 'cards/a.json', 'A', '阿芙拉'),
    record('worldbook', 'worldbooks/b.json', 'B', '大陆世界书'),
    record('preset', 'presets/c.json', 'C', '预设'),
  ])
  assert.deepEqual(result.removed, [
    { kind: 'card', title: '阿芙拉', path: 'cards/a.json' },
    { kind: 'worldbook', title: '大陆世界书', path: 'worldbooks/b.json' },
    { kind: 'preset', title: '预设', path: 'presets/c.json' },
  ])
  assert.deepEqual(result.skipped, [])
  assert.deepEqual(store.removed, ['card:cards/a.json', 'worldbook:worldbooks/b.json', 'preset:presets/c.json'])
  assert.equal(store.files.size, 0)
})

test('导入后内容被改动的文件跳过并报告', async () => {
  const store = fakeStore({ 'card:cards/a.json': '用户改过的 A', 'worldbook:worldbooks/b.json': 'B' })
  const { undo } = createTransferUndo({ hashOf: store.hashOf, remove: store.remove })
  const result = await undo([record('card', 'cards/a.json', 'A', '阿芙拉'), record('worldbook', 'worldbooks/b.json', 'B')])
  assert.deepEqual(result.skipped, [{ kind: 'card', title: '阿芙拉', path: 'cards/a.json', reason: '导入后内容已改动' }])
  assert.deepEqual(result.removed, [{ kind: 'worldbook', title: 'worldbooks/b.json', path: 'worldbooks/b.json' }])
  assert.equal(store.files.get('card:cards/a.json'), '用户改过的 A')
  assert.deepEqual(store.removed, ['worldbook:worldbooks/b.json'])
})

test('文件已被用户删除时跳过', async () => {
  const store = fakeStore()
  const { undo } = createTransferUndo({ hashOf: store.hashOf, remove: store.remove })
  const result = await undo([record('card', 'cards/a.json', 'A', '阿芙拉')])
  assert.deepEqual(result.removed, [])
  assert.deepEqual(result.skipped, [{ kind: 'card', title: '阿芙拉', path: 'cards/a.json', reason: '文件已不存在' }])
  assert.deepEqual(store.removed, [])
})

test('删除抛错记入 skipped，不影响后续条目', async () => {
  const store = fakeStore({ 'card:cards/a.json': 'A', 'card:cards/b.json': 'B' })
  store.failRemove('card:cards/a.json', 'EBUSY: 文件被占用')
  const { undo } = createTransferUndo({ hashOf: store.hashOf, remove: store.remove })
  const result = await undo([record('card', 'cards/a.json', 'A'), record('card', 'cards/b.json', 'B')])
  assert.deepEqual(result.skipped, [{ kind: 'card', title: 'cards/a.json', path: 'cards/a.json', reason: '删除失败：EBUSY: 文件被占用' }])
  assert.deepEqual(result.removed, [{ kind: 'card', title: 'cards/b.json', path: 'cards/b.json' }])
  assert.equal(store.files.has('card:cards/a.json'), true)
  assert.equal(store.files.has('card:cards/b.json'), false)
})

test('记录不完整时跳过（缺 path、缺哈希、未知条目）', async () => {
  const store = fakeStore({ 'card:cards/a.json': 'A' })
  const { undo } = createTransferUndo({ hashOf: store.hashOf, remove: store.remove })
  const result = await undo([
    { kind: 'card', title: '缺路径', sha256: sha('A') },
    { kind: 'card', title: '缺哈希', path: 'cards/a.json' },
    null,
    'not-a-record',
    record('card', 'cards/a.json', 'A', '正常条目'),
  ])
  assert.equal(result.removed.length, 1)
  assert.deepEqual(result.removed[0], { kind: 'card', title: '正常条目', path: 'cards/a.json' })
  assert.deepEqual(result.skipped.map(item => item.reason), ['记录不完整', '记录不完整', '记录不完整', '记录不完整'])
  assert.deepEqual(store.removed, ['card:cards/a.json'])
})

test('部分删除：数量与顺序都按输入记录保留', async () => {
  const store = fakeStore({ 'card:cards/a.json': 'A', 'card:cards/b.json': 'B改', 'card:cards/c.json': 'C' })
  const { undo } = createTransferUndo({ hashOf: store.hashOf, remove: store.remove })
  const result = await undo([
    record('card', 'cards/a.json', 'A', '一'),
    record('card', 'cards/b.json', 'B', '二'),
    record('card', 'cards/c.json', 'C', '三'),
  ])
  assert.deepEqual(result.removed.map(item => item.title), ['一', '三'])
  assert.deepEqual(result.skipped.map(item => item.title), ['二'])
  assert.deepEqual(store.removed, ['card:cards/a.json', 'card:cards/c.json'])
})

test('冻结返回值，并拒绝缺少依赖', async () => {
  const store = fakeStore()
  const service = createTransferUndo({ hashOf: store.hashOf, remove: store.remove })
  assert.equal(Object.isFrozen(service), true)
  assert.deepEqual(Object.keys(service), ['undo'])
  assert.throws(() => createTransferUndo({ hashOf: store.hashOf }), /缺少导入记录哈希或删除能力/)
  assert.deepEqual(await service.undo([]), { removed: [], skipped: [] })
})
