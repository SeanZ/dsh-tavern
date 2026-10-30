import test from 'node:test'
import assert from 'node:assert/strict'
import { createPluginMedia } from '../tavern-plugin/lib/domain/plugin-media.js'
import { createPluginMediaViews } from '../tavern-plugin/lib/domain/plugin-media-views.js'
import { registerTavernHttpRoutes } from '../tavern-plugin/lib/http/routes.js'
import { createMediaHandlers } from '../tavern-plugin/lib/rpc/media.js'

function memoryStore() {
  const files = new Map()
  return {
    async readJson(path) { return files.has(path) ? structuredClone(files.get(path)) : undefined },
    async updateJson(path, updater) {
      const next = await updater(files.has(path) ? structuredClone(files.get(path)) : undefined)
      if (next !== undefined) files.set(path, structuredClone(next))
      return next
    },
    async remove(path) { files.delete(path) }
  }
}

const str = value => value == null ? '' : String(value)

function productionGallery({ pluginMedia, pluginTurns, sessionSignals }) {
  return createPluginMediaViews({ pluginMedia, pluginTurns, sessionSignals, attachments: () => null })
}

function productionRemoveHistoryRpc({ removePluginGalleryItems }) {
  const handlers = createMediaHandlers({ removePluginGalleryItems, str })
  return args => handlers.removeSceneImageHistory(args)
}

test('production plugin gallery filters by game, current text version, ready image status, and removes only that game', async () => {
  const store = memoryStore(), media = createPluginMedia({ store })
  const current = new Map([['session-a:1', 'key-a-now'], ['session-a:2', 'key-a-2'], ['session-b:1', 'key-b-now']])
  const games = new Map([['session-a', { sessionId: 'session-a', chatId: 'chat-a' }], ['session-b', { sessionId: 'session-b', chatId: 'chat-b' }]])
  const notifications = []
  const pluginTurns = {
    async resolveGame(sessionId) { return games.get(sessionId) || null },
    async currentKey(sessionId, turn) { return current.get(`${sessionId}:${turn}`) || null }
  }
  const signals = { publish(...args) { notifications.push(args) } }
  const gallery = await productionGallery({ pluginMedia: media, pluginTurns, sessionSignals: signals })
  let serial = 0
  async function add({ chatId, sessionId, turn = 1, key, status = 'ready', mediaType = 'image/png' }) {
    if (key !== await pluginTurns.currentKey(sessionId, turn)) await media.issue(chatId, turn, key)
    const isImage = mediaType.startsWith('image/')
    return media.attach({ chatId, sessionId, owner: 'image-plugin', turn, key,
      currentKey: await pluginTurns.currentKey(sessionId, turn), item: {
        kind: isImage ? 'image' : 'audio', status, caption: `item-${++serial}`,
        ...(status === 'ready' ? { attachment: isImage
          ? { attachmentId: `attachment-${serial}`, mediaType, bytes: 1 }
          : { attachmentId: `attachment-${serial}`, name: 'sound.mp3', bytes: 1 } } : {})
      } })
  }
  const visible = await add({ chatId: 'chat-a', sessionId: 'session-a', key: 'key-a-now' })
  const otherGame = await add({ chatId: 'chat-b', sessionId: 'session-b', key: 'key-b-now' })
  await add({ chatId: 'chat-a', sessionId: 'session-a', key: 'key-a-now', status: 'pending' })
  await add({ chatId: 'chat-a', sessionId: 'session-a', key: 'key-a-now', status: 'failed' })
  await add({ chatId: 'chat-a', sessionId: 'session-a', key: 'key-a-now', mediaType: 'audio/mpeg' })
  const stale = await add({ chatId: 'chat-a', sessionId: 'session-a', key: 'key-a-old' })
  const swipeOld = await add({ chatId: 'chat-a', sessionId: 'session-a', turn: 2, key: 'key-a-2' })
  current.set('session-a:2', 'key-a-swiped')

  const listed = await gallery.pluginGalleryItems('session-a')
  assert.deepEqual(listed.map(item => item.id), [visible.id])
  assert.deepEqual(await gallery.pluginGalleryItems('session-b').then(items => items.map(item => item.id)), [otherGame.id])
  assert.deepEqual(await gallery.pluginGalleryItems('missing'), [])

  const crossGame = await gallery.removePluginGalleryItems('session-a', [otherGame.id])
  assert.equal(crossGame[0].ok, false)
  assert.ok(await media.find('chat-b', otherGame.id), 'another session item remains intact')
  assert.equal(notifications.length, 0, 'failed cross-game removal does not notify')

  const results = await gallery.removePluginGalleryItems('session-a', ['missing-id', stale.id, swipeOld.id, visible.id])
  assert.deepEqual(results.map(item => item.ok), [false, true, true, true])
  assert.match(results[0].error, /不存在/)
  assert.equal(await media.find('chat-a', visible.id), null)
  assert.equal(await media.find('chat-a', stale.id), null)
  assert.equal(await media.find('chat-a', swipeOld.id), null)
  assert.equal(notifications.length, 1, 'successful removal batch publishes one gallery change')
  assert.deepEqual(notifications[0][0], 'session-a')
  assert.equal(notifications[0][1].kind, 'plugin-media')
})

test('production removeSceneImageHistory deletes only plugin pictures, at most 500, in the given game', async () => {
  const pluginCalls = []
  const removePluginGalleryItems = async (sessionId, ids) => { pluginCalls.push({ sessionId, ids }); return ids.map(id => ({ versionId: id, ok: true })) }
  const rpc = productionRemoveHistoryRpc({ removePluginGalleryItems })
  await assert.rejects(rpc({ sessionId: 'session-a', pluginItems: Array(501).fill('plugin-id') }), /最多删除 500/)
  await assert.rejects(rpc({ sessionId: 'session-a', pluginItems: 'plugin-id' }), /最多删除 500/)
  assert.deepEqual(pluginCalls, [], 'invalid input is rejected before any deletion')
  const scoped = await rpc({ sessionId: 'session-a', pluginItems: ['plugin-a'] })
  assert.deepEqual(scoped.results.map(result => result.versionId), ['plugin-a'])
  assert.deepEqual(pluginCalls, [{ sessionId: 'session-a', ids: ['plugin-a'] }])
})

test('real HTTP routes serve plugin pictures, reject hostile origins, and dispatch gallery RPCs', async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
  const calls = [], registered = new Map()
  let handler
  const webServer = { register(route) { registered.set(route.path, route.handler); return () => registered.delete(route.path) } }
  const ctx = { get: name => name === 'webServer' ? webServer : { requestRejection: () => undefined }, effect(callback) { callback() } }
  const dispatch = async (method, args) => { calls.push(['rpc', method, args]); return method === 'listSceneImageHistory' ? { items: [], pluginItems: [] } : { results: [] } }
  registerTavernHttpRoutes({ ctx, dispatch,
    readPluginMediaFile: async (sessionId, id) => { calls.push(['plugin-media', sessionId, id]); return { data: png, length: png.byteLength, mediaType: 'image/png' } },
    performanceDiagnostics: { http() {} }, runtimeGeneration: 'test', runtimeReadiness: Promise.resolve({ ok: true }), str })
  handler = registered.get('/api/dsh-tavern')
  assert.equal(typeof handler, 'function')

  async function request(url, { method = 'GET', origin, body } = {}) {
    const response = {}
    const req = { url, method, headers: { host: 'localhost:3081', ...(origin ? { origin } : {}) },
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(body) } }
    await handler(req, { writeHead(status, headers = {}) { response.status = status; response.headers = headers }, end(value) { response.body = value } })
    return response
  }

  const denied = await request('/api/dsh-tavern/plugin-media?sessionId=s&id=image-id', { origin: 'https://evil.example' })
  assert.equal(denied.status, 403)
  const pluginImage = await request('/api/dsh-tavern/plugin-media?sessionId=s&id=image-id')
  assert.equal(pluginImage.status, 200)
  assert.equal(pluginImage.headers['Content-Type'], 'image/png')
  assert.deepEqual(pluginImage.body, png)
  assert.equal(calls.filter(call => call[0] === 'plugin-media').length, 1, 'hostile-origin read never reaches plugin media')

  for (const method of ['listSceneImageHistory', 'removeSceneImageHistory']) {
    const response = await request('/api/dsh-tavern/' + method, { method: 'POST', body: JSON.stringify({ sessionId: 's', pluginItems: [] }) })
    assert.equal(response.status, 200)
    assert.equal(JSON.parse(response.body).ok, true)
  }
  assert.deepEqual(calls.filter(call => call[0] === 'rpc').map(call => call[1]), ['listSceneImageHistory', 'removeSceneImageHistory'])
})
