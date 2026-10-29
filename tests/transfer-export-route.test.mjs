import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Writable } from 'node:stream'

import { registerTavernHttpRoutes } from '../tavern-plugin/lib/http/routes.js'
import { createTransferExportStore } from '../tavern-plugin/lib/domain/transfer-store.js'

// 手机内嵌窗口第一次下载常常被丢掉，用户会再点一次同一个链接。以前 token 一次性，
// 第二次就是 404「export expired」；这里按 HTTP 层把「同一个链接能再取一次」钉住。
function handle(transferExports) {
  let handler
  registerTavernHttpRoutes({
    ctx: { get: () => undefined, effect: () => {} },
    dispatch: async () => {},
    fileResources: {}, helperHistoryAccess: {}, mobileCardImport: {},
    performanceDiagnostics: {}, runtimeGeneration: 1, runtimeReadiness: { ok: true },
    sceneIllustrations: {}, readPluginMediaFile: async () => {},
    pluginAssets: {}, sessionResources: { read: async () => '{}' },
    str: String, tavernRemoteAssets: {}, tavernStaticResources: {},
    castAssets: {}, assetLibrary: undefined, speech: {},
    exportCardFile: async () => {}, assetPacks: {}, uploads: {},
    transferExports,
    exposeHandler: fn => { handler = fn },
  })
  return handler
}

class Response extends Writable {
  constructor() {
    super()
    this.status = 0
    this.headers = {}
    this.chunks = []
  }
  writeHead(status, headers) { this.status = status; this.headers = headers || {} }
  _write(chunk, _encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback() }
  end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); return super.end() }
  get body() { return Buffer.concat(this.chunks).toString('utf8') }
}

async function call(handler, url, method = 'GET') {
  const res = new Response()
  await handler({ method, url, headers: { host: '127.0.0.1:3088' } }, res)
  await new Promise(resolve => res.on('finish', resolve))
  return res
}

// Android 的 URLUtil.guessFileName 在拿不到 Content-Disposition 时退回 URL 最后一段。
function nameFromUrl(url) {
  return decodeURIComponent(new URL(url, 'http://127.0.0.1:3088').pathname.split('/').pop())
}

const NAME = 'DSH酒馆备份-20261029-1530.dshtransfer'
const urlFor = token => '/api/dsh-tavern/transfer-export/' + encodeURIComponent(NAME) + '?token=' + token

test('大包下载链接在有效期内可以反复取，不会第二次 404', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'transfer-route-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const exports = createTransferExportStore({ root })
  const { token } = await exports.put(Buffer.from('zip-bytes'), NAME)
  const handler = handle(exports)
  const url = urlFor(token)

  const first = await call(handler, url)
  assert.equal(first.status, 200, '第一次下载应成功')
  assert.equal(first.body, 'zip-bytes')
  assert.match(first.headers['Content-Disposition'], /attachment/)

  const second = await call(handler, url)
  assert.equal(second.status, 200, 'WebView 丢掉第一次之后，重试同一个链接仍要能拿到文件')
  assert.equal(second.body, 'zip-bytes')

  const head = await call(handler, url, 'HEAD')
  assert.equal(head.status, 200)
  assert.equal(head.body, '')
})

test('下载器只在链接上看得见文件名时，文件名仍是 .dshtransfer，不会退化成 transfer-export.bin', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'transfer-route-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const exports = createTransferExportStore({ root })
  const { token } = await exports.put(Buffer.from('zip-bytes'), NAME)
  const handler = handle(exports)
  const url = urlFor(token)

  const res = await call(handler, url)
  assert.equal(res.status, 200)
  assert.equal(nameFromUrl(url), NAME, 'URL 最后一段就是下载器看到的名字')
  assert.match(res.headers['Content-Disposition'], /filename="tavern-backup\.dshtransfer"/)
  assert.match(res.headers['Content-Disposition'], /filename\*=UTF-8''/)

  // 旧式不带文件名的链接仍要能用（老页面还缓存着这种地址）。
  const legacy = '/api/dsh-tavern/transfer-export?token=' + token
  const fallback = await call(handler, legacy)
  assert.equal(fallback.status, 200)
  assert.equal(decodeURIComponent(/filename\*=UTF-8''(.*)$/.exec(fallback.headers['Content-Disposition'])[1]), NAME)
})

test('未知或过期的 token 仍是 404', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'transfer-route-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let now = 1000
  const exports = createTransferExportStore({ root, now: () => now, ttlMs: 5000 })
  const { token } = await exports.put(Buffer.from('x'), 'a.dshtransfer')
  const handler = handle(exports)
  const url = urlFor(token)

  assert.equal((await call(handler, '/api/dsh-tavern/transfer-export?token=' + '0'.repeat(36))).status, 404)
  now = 7000
  assert.equal((await call(handler, url)).status, 404)
})
