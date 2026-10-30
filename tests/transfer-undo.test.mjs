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
