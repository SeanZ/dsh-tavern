import { readFile } from 'node:fs/promises'
import vm from './client-vm.mjs'
import { projectStoryTranscript } from '../../tavern-plugin/lib/domain/story-transcript.js'

const source = await readFile(new URL('../../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
const React = { createElement: (type, props) => ({ type, props }), Fragment: 'Fragment', memo: value => value, forwardRef: value => value, createContext: () => ({}) }
export const plain = value => JSON.parse(JSON.stringify(value))
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
export const rows = (count = 3) => Array.from({ length: count }, (_, index) => [
  { role: 'user', turn: index + 1, messageUid: 'u' + (index + 1), text: '输入' + (index + 1) },
  { role: 'assistant', turn: index + 1, messageUid: 'm' + (index + 1), text: '正文' + (index + 1) }
]).flat()
export function eventWindow(events = []) {
  const listeners = new Set()
  let state = { entries: events.map(event => ({ type: 'event', event })), hasMore: false, revision: 0, change: { kind: 'replace', entries: [] } }
  return {
    source: { getSnapshot: () => state, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) } },
    append(entry) { state = { ...state, entries: [...state.entries, entry], revision: state.revision + 1, change: { kind: 'append', entries: [entry] } }; for (const fn of listeners) fn() },
    replace(entries) { state = { ...state, entries, revision: state.revision + 1, change: { kind: 'replace', entries } }; for (const fn of listeners) fn() }
  }
}

// 使用实际构建客户端和服务端逻辑消息投影，仅替换 HTTP 与宿主事件输入。
export async function fixture(t, { messages = rows(), replies = {}, events = [], initialFrom = 0 } = {}) {
  let descriptor
  const calls = [], windows = { s1: eventWindow(events) }, seen = new Map(), stops = []
  const chats = new Map([['s1', { messages, revision: 1, from: initialFrom }]])
  const views = new Map([['s1', { mode: 'story', canRegenerate: true, rollbackTargetTurn: 3 }]])
  const window = { __ModuleLoader__: { load(value) { descriptor = value } }, setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout, dispatchEvent() {}, addEventListener() {}, removeEventListener() {} }
  const fetch = async (url, request) => {
    const method = url.split('/').pop(), { _performance, _traceId, ...args } = JSON.parse(request.body)
    calls.push({ method, args })
    let body
    if (Object.hasOwn(replies, method)) body = typeof replies[method] === 'function' ? await replies[method](args) : replies[method]
    else if (method === 'getStoryTranscript') {
      const chat = chats.get(args.sessionId)
      if (chat) {
        const from = args.historyFrom ?? chat.from
        body = { storyTranscript: projectStoryTranscript({ chat: { messages: chat.messages.slice(from) }, from, to: chat.messages.length - 1, messageCount: chat.messages.length, revision: chat.revision }, chat.messages), view: views.get(args.sessionId) }
      }
    } else if (method === 'getSession') body = { view: views.get(args.sessionId) }
    else if (method === 'getCoordination') body = { view: {} }
    const result = body === undefined ? { ok: false, error: 'not in test: ' + method } : body.error ? { ok: false, error: body.error } : { ok: true, ...body }
    return { ok: true, status: 200, text: async () => JSON.stringify(result) }
  }
  const context = { window, fetch, performance, console, AbortController, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } } }
  vm.runInNewContext(source, context)
  const client = descriptor.factory(name => name === 'react' ? React : {})
  context.document = { body: {}, querySelectorAll: () => [], querySelector: () => null }
  // 与 bindings.js 的正式接线一致：服务依赖公开渲染器读取 rendererVersion，快照读回按它过滤。
  const render = client.createTavernStoryRender({})
  const service = client.createTavernStoryService({ sessions: { binding: id => windows[id] && { eventSource: windows[id].source } }, actions: client.playControlsFeature.storyActions, render })
  t.after(() => stops.forEach(stop => stop()))
  async function open(id = 's1') {
    client.liveTavernView.setView(id, views.get(id))
    seen.set(id, [])
    stops.push(service.subscribeRounds(id, value => seen.get(id).push(value)))
    for (let count = 0; count < 100 && !seen.get(id).some(value => value.revision !== null); count++) await delay(5)
    if (!seen.get(id).some(value => value.revision !== null)) throw new Error('逻辑历史没有加载')
    return snapshot(id)
  }
  const snapshot = (id = 's1') => seen.get(id)?.at(-1)
  function view(value, id = 's1') { views.set(id, value); client.liveTavernView.setView(id, value) }
  await open()
  return { client, service, render, chats, views, windows, seen, calls, replies, open, snapshot, view,
    target(number = 3, id = 's1') { return snapshot(id).floors.find(floor => floor.story === number)?.target } }
}
