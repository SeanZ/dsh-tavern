import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createTransferExportStore } from '../tavern-plugin/lib/domain/transfer-store.js'

async function store(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'transfer-store-'))
  return { store: createTransferExportStore(Object.assign({ root }, options)), root }
}

test('大包写入后能凭 token 取回路径与文件，下载后可删除', async t => {
  const { store: exports, root } = await store()
  t.after(() => rm(root, { recursive: true, force: true }))
  const { token, bytes } = await exports.put(Buffer.from('zip-bytes'), '备份.dshtransfer')
  assert.equal(bytes, 9)
  const found = exports.take(token)
  assert.equal(found.filename, '备份.dshtransfer')
  assert.equal(found.bytes, 9)
  const chunks = []
  for await (const chunk of found.stream()) chunks.push(chunk)
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'zip-bytes')
  await exports.remove(token)
  assert.equal(exports.take(token), null)
})

test('过期 token 取不到，也不再把文件留给下一个请求', async t => {
  let now = 1000
  const { store: exports, root } = await store({ now: () => now, ttlMs: 5000 })
  t.after(() => rm(root, { recursive: true, force: true }))
  const { token } = await exports.put(Buffer.from('x'), 'a.dshtransfer')
  now = 7000
  assert.equal(exports.take(token), null)
  await exports.sweep()
  assert.equal(exports.take(token), null)
})

test('重启后残留的导出文件由 sweep 按时间清理', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'transfer-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = createTransferExportStore({ root })
  const { token } = await first.put(Buffer.from('old'), 'b.dshtransfer')
  const file = path.join(root, token)
  assert.equal((await readFile(file)).toString('utf8'), 'old')

  // A fresh store has no tokens; sweeping with a later clock collects the orphan file.
  const later = createTransferExportStore({ root, now: () => Date.now() + 2 * 60 * 60 * 1000 })
  await later.sweep()
  await assert.rejects(async () => readFile(file), /ENOENT/)
})

test('未知 token 返回 null，不抛错', async t => {
  const { store: exports, root } = await store()
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal(exports.take('00000000-0000-0000-0000-000000000000'), null)
  assert.equal(exports.take('../etc/passwd'), null)
})
