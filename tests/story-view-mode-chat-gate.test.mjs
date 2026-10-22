import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// Fork contract C4: storyViewMode on leaves the chat rows to the host.
const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
const React = { createElement: (type, props) => ({ type, props }), Fragment: 'Fragment', memo: value => value, forwardRef: value => value, createContext: () => ({}) }
function loadClient({ cached = null, settings = { storyViewMode: false } } = {}) {
  let descriptor
  const storage = new Map(cached === null ? [] : [['dsh-tavern:story-view-mode', cached]])
  const listeners = new Map()
  const window = {
    __ModuleLoader__: { load(value) { descriptor = value } }, setTimeout, clearTimeout,
    localStorage: { getItem: key => storage.has(key) ? storage.get(key) : null, setItem: (key, value) => storage.set(key, String(value)) },
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name)
  }
  const calls = []
  const fetch = async (url, request) => {
    const { _performance, ...args } = JSON.parse(request.body)
    calls.push({ method: url.split('/').pop(), args })
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, settings }) }
  }
  vm.runInNewContext(source, { window, fetch, performance, console })
  return { client: descriptor.factory(name => name === 'react' ? React : {}), storage, listeners, calls }
}
function register(client) {
  const live = new Map()
  const ctx = { sessions: {}, get: () => null, effect(run) { try { return run() } catch (_) {} } }
  const slots = { inject: (_name, run) => run(), register(options) { const id = options.name + ':' + (options.key || options.id); live.set(id, (live.get(id) || 0) + 1); return () => live.set(id, live.get(id) - 1) } }
  client.createTavernAssistantRendererFeatureModule().register({ ctx, slots })
  return id => live.get(id) || 0
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('故事视图模式关闭（默认）时照常注册聊天行渲染器与助手行按钮', () => {
  const { client } = loadClient()
  const count = register(client)
  for (const id of ['conversation.chat.node:assistant-step', 'conversation.chat.node:user', 'conversation.chat.assistant-actions:dsh-tavern-fork', 'conversation.chat.assistant-actions:dsh-tavern-illustrate']) assert.equal(count(id), 1, id)
})

test('故事视图模式开启时不注册聊天行，宿主原生渲染；会话脚本运行时照常', () => {
  const { client } = loadClient({ cached: '1' })
  const count = register(client)
  for (const id of ['conversation.chat.node:assistant-step', 'conversation.chat.node:user', 'conversation.chat.assistant-actions:dsh-tavern-fork', 'conversation.chat.assistant-actions:dsh-tavern-illustrate']) assert.equal(count(id), 0, id)
  assert.equal(count('conversation.session.header.actions:dsh-tavern-script-runtime'), 1, '人物卡脚本运行时（状态栏等）不属于聊天行')
})

test('设置读到后切换注册，跨标签页变更也生效', async () => {
  const { client, storage, listeners, calls } = loadClient({ settings: { storyViewMode: true } })
  const count = register(client)
  assert.equal(count('conversation.chat.node:user'), 1)
  await client.tavernStoryViewMode.refresh()
  assert.ok(calls.some(call => call.method === 'getTavernSettings'))
  assert.equal(count('conversation.chat.node:user'), 0, '开启后撤下 Tavern 行渲染器')
  assert.equal(count('conversation.chat.assistant-actions:dsh-tavern-fork'), 0)
  assert.equal(storage.get('dsh-tavern:story-view-mode'), '1', '缓存供下次首屏使用')
  const stop = client.tavernStoryViewMode.start()
  await tick()
  listeners.get('storage')({ key: 'dsh-tavern:story-view-mode', newValue: '0' })
  assert.equal(count('conversation.chat.node:user'), 1, '另一标签页关闭后重新注册，且只注册一份')
  assert.equal(count('conversation.chat.node:assistant-step'), 1)
  stop()
})

test('set 写入全局设置并立即切换', async () => {
  const { client, calls } = loadClient({ settings: { storyViewMode: true } })
  const count = register(client)
  assert.equal(await client.tavernStoryViewMode.set(true), true)
  assert.deepEqual(calls.find(call => call.method === 'updateTavernSettings'), { method: 'updateTavernSettings', args: { patch: { storyViewMode: true } } })
  assert.equal(count('conversation.chat.node:assistant-step'), 0)
  await assert.rejects(client.tavernStoryViewMode.set('yes'), /布尔值/)
})
