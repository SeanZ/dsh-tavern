import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
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
  const found = await exports.take(token)
  assert.equal(found.filename, '备份.dshtransfer')
  assert.equal(found.bytes, 9)
  const chunks = []
  for await (const chunk of found.stream()) chunks.push(chunk)
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'zip-bytes')
  await exports.remove(token)
  assert.equal(await exports.take(token), null)
})
