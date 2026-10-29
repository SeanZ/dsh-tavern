import assert from 'node:assert/strict'
import test from 'node:test'
import { createTavernConversationRegistry } from '../tavern-plugin/lib/domain/tavern-conversation-registry.js'

function memoryStore(seed = {}) {
  let links = structuredClone(seed.links || {})
  let index = structuredClone(seed.index || { chats: [] })
  const chats = new Map(Object.entries(structuredClone(seed.chats || {})))
  const failures = seed.failures || {}
  let chatReads = 0
  let linkUpdates = 0
  return {
    adapter: {
      async readLinks() { return structuredClone(links) },
      async updateLinks(updater) {
        linkUpdates += 1
        const result = await updater(structuredClone(links))
        if (result !== undefined) links = structuredClone(result)
      },
      async readIndex() { return structuredClone(index) },
      async updateIndex(updater) { const next = await updater(await this.readIndex()); if (next !== undefined) await this.writeIndex(next); return next },
      async writeIndex(value) {
        if (failures.writeIndex) throw new Error(failures.writeIndex)
        index = structuredClone(value)
      },
      async readChat(id) {
        chatReads += 1
        if (failures.readChat) throw new Error(failures.readChat)
        return chats.has(id) ? structuredClone(chats.get(id)) : undefined
      },
      async writeChat(chat) { chats.set(chat.id, structuredClone(chat)) },
      async removeChat(id) { chats.delete(id) }
    },
    snapshot() { return { links: structuredClone(links), index: structuredClone(index), chats: Object.fromEntries(chats), chatReads } },
    counts() { return { linkUpdates } }
  }
}

test('索引发布失败时回滚 Chat 和 Session 关联', async function () {
  const store = memoryStore({ failures: { writeIndex: 'index locked' } })
  const registry = createTavernConversationRegistry({ store: store.adapter })

  await assert.rejects(registry.publish({ id: 'chat-2', sessionId: 'session-2', cardPath: '', cardName: 'B', updatedAt: 20 }), /index locked/)

  assert.deepEqual(store.snapshot().links, {})
  assert.deepEqual(store.snapshot().chats, {})
})

test('损坏映射会从 Chat 索引自愈并清除失效目标', async function () {
  const chat = { id: 'chat-real', sessionId: 'session-3', cardPath: '', cardName: 'C' }
  const store = memoryStore({
    links: { 'session-3': 'chat-missing' },
    index: { chats: [{ id: 'chat-real' }] },
    chats: { 'chat-real': chat }
  })
  const registry = createTavernConversationRegistry({ store: store.adapter })

  assert.deepEqual(await registry.resolve('session-3'), chat)
  assert.deepEqual(store.snapshot().links, { 'session-3': 'chat-real' })
})

test('后台轮换写入轻量索引，恢复旧后台后重新成为当前，列表不加载历史', async () => {
  const store = memoryStore({ links: { front: 'game' } })
  const registry = createTavernConversationRegistry({ store: store.adapter })
  const chat = { id: 'game', messages: [], timeline: { participants: { background: { sessionId: 'old' } } } }
  await registry.sync(chat)
  chat.timeline.participants.background.sessionId = 'new'
  await registry.sync(chat)
  assert.deepEqual((await registry.list())[0].backgroundHistoryIds, ['old'])
  chat.timeline.participants.background.sessionId = 'old'
  await registry.sync(chat)
  const row = (await registry.list())[0]
  assert.equal(row.backgroundSessionId, 'old')
  assert.deepEqual(row.backgroundHistoryIds, ['new'])
  assert.equal(store.snapshot().chatReads, 0)
})

test('共享磁盘索引的并发发布、同步、打开和删除保留各自改动', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createProfileDataStore } = await import('../tavern-plugin/lib/profile-data-store.js')
  const root = await mkdtemp(join(tmpdir(), 'tavern-registry-race-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const data = createProfileDataStore({ dataRoot: root })
  let racing = true, reads = 0, release
  const readBarrier = new Promise(resolve => { release = resolve })
  const store = {
    readLinks: () => data.readJson('sessions.json'),
    updateLinks: fn => data.updateJson('sessions.json', fn),
    async readIndex() {
      const value = await data.readJson('index.json') || { chats: [] }
      // The old read/overwrite implementation deterministically loses a row.
      if (racing) { if (++reads === 2) release(); await readBarrier }
      return value
    },
    writeIndex: value => data.writeJson('index.json', value),
    updateIndex: fn => data.updateJson('index.json', fn),
    readChat: id => data.readJson('chats/' + id + '.json'),
    writeChat: chat => data.writeJson('chats/' + chat.id + '.json', chat),
    removeChat: id => data.remove('chats/' + id + '.json')
  }
  // Two instances must share the storage transaction, not just an instance lock.
  const first = createTavernConversationRegistry({ store })
  const second = createTavernConversationRegistry({ store })
  const chat = id => ({ id, sessionId: 'session-' + id, title: id, createdAt: 1, updatedAt: 1 })
  await data.writeJson('index.json', { cards: ['kept'], custom: true, chats: [] })
  await Promise.all([first.publish(chat('a')), second.publish(chat('b'))])
  racing = false
  assert.deepEqual((await first.list()).map(row => row.chatId).sort(), ['a', 'b'])
  await first.publish(chat('removed'))
  await Promise.all([
    first.sync({ ...chat('a'), title: 'updated', updatedAt: 2 }),
    second.touch('session-b', 100),
    first.remove('removed'),
    second.publish(chat('c'))
  ])
  const index = await data.readJson('index.json')
  assert.deepEqual(index.chats.map(row => row.id).sort(), ['a', 'b', 'c'])
  assert.equal(index.chats.find(row => row.id === 'a').title, 'updated')
  assert.equal(index.chats.find(row => row.id === 'b').lastOpenedAt, 100)
  assert.deepEqual(index.cards, ['kept'])
  assert.equal(index.custom, true)
  assert.equal(await store.readChat('removed'), undefined)
  assert.deepEqual(Object.keys(await store.readLinks()).sort(), ['session-a', 'session-b', 'session-c'])
})

test('磁盘上有、索引里没有的存档会重新登记，已登记和已关联的不受影响（#251）', async function () {
  const store = memoryStore({
    index: { schemaVersion: 2, cards: [], chats: [{ id: 'chat-new', cardName: '新', mode: 'story' }] },
    links: { 'session-new': 'chat-new', 'session-taken': 'chat-new' },
    chats: {
      'chat-new': { id: 'chat-new', sessionId: 'session-new', cardName: '新', updatedAt: 30 },
      'chat-lost': { id: 'chat-lost', sessionId: 'session-lost', cardName: '旧', title: '旧存档', mode: 'story', createdAt: 10, updatedAt: 20 },
      'chat-taken': { id: 'chat-taken', sessionId: 'session-taken', cardName: '别名', updatedAt: 5 },
    }
  })
  const registry = createTavernConversationRegistry({ store: store.adapter })
  assert.deepEqual(await registry.recoverUnlisted(['chat-new', 'chat-lost', 'chat-taken', 'chat-gone']), ['chat-lost', 'chat-taken'])
  const { index, links } = store.snapshot()
  assert.deepEqual(index.chats.map(row => row.id), ['chat-new', 'chat-lost', 'chat-taken'])
  assert.equal(index.schemaVersion, 2)
  assert.equal(index.chats[1].title, '旧存档')
  assert.equal(links['session-lost'], 'chat-lost')
  assert.equal(links['session-taken'], 'chat-new', 'an existing link is never overwritten')
  assert.deepEqual(await registry.recoverUnlisted(['chat-new', 'chat-lost']), [], 'a second pass changes nothing')
})

test('删除先删存档本体再删登记，删到一半中断也不会被重新登记', async function () {
  const store = memoryStore({ failures: {} })
  const registry = createTavernConversationRegistry({ store: store.adapter })
  await registry.publish({ id: 'chat-x', sessionId: 'session-x', cardName: 'X', updatedAt: 1 })
  store.adapter.updateIndex = async () => { throw new Error('interrupted') }
  await assert.rejects(registry.remove('chat-x'), /interrupted/)
  assert.equal(store.snapshot().chats['chat-x'], undefined)
  assert.deepEqual(await registry.recoverUnlisted(['chat-x']), [])
})

// Background agents ask for their own session on every request; none of them owns a chat.
test('没有存档的会话只扫描一次；新存档或新链接出现后再扫描', async function () {
  const store = memoryStore({
    index: { chats: [{ id: 'chat-a' }, { id: 'chat-b' }] },
    chats: { 'chat-a': { id: 'chat-a', sessionId: 'game-a' }, 'chat-b': { id: 'chat-b', sessionId: 'game-b' } }
  })
  const registry = createTavernConversationRegistry({ store: store.adapter })
  assert.equal(await registry.resolve('background-1'), undefined)
  const scanned = store.snapshot().chatReads
  assert.ok(scanned >= 2)
  for (let i = 0; i < 5; i++) assert.equal(await registry.resolve('background-1'), undefined)
  assert.equal(store.snapshot().chatReads, scanned, '再次查询不再逐个读存档')
  // A chat restored for that session (index changed) is found on the next lookup.
  await store.adapter.writeChat({ id: 'chat-c', sessionId: 'background-1' })
  await store.adapter.writeIndex({ chats: [{ id: 'chat-a' }, { id: 'chat-b' }, { id: 'chat-c' }] })
  assert.equal((await registry.resolve('background-1'))?.id, 'chat-c')
})

test('恢复扫描只为命中的存档读盘，不按存档数量放大', async function () {
  const chats = {}, rows = []
  for (let index = 0; index < 40; index++) {
    const id = 'chat-bulk-' + index
    chats[id] = { id, sessionId: 'session-bulk-' + index, cardPath: '', cardName: 'C' + index }
    rows.push({ id, sessionId: 'session-bulk-' + index })
  }
  const store = memoryStore({ index: { chats: rows }, chats })
  const registry = createTavernConversationRegistry({ store: store.adapter })
  const resolved = await registry.resolve('session-bulk-7')
  assert.equal(resolved.id, 'chat-bulk-7')
  assert.equal(store.snapshot().chatReads, 1, '四十个存档只读命中的那一个')
  assert.deepEqual(store.snapshot().links, { 'session-bulk-7': 'chat-bulk-7' })
})

test('新摘要带上绑定的 Session，索引行直接可比对', async function () {
  const store = memoryStore({})
  const registry = createTavernConversationRegistry({ store: store.adapter })
  await registry.publish({ id: 'chat-s', sessionId: 'session-s', cardPath: '', cardName: 'S', updatedAt: 10 })
  assert.equal(store.snapshot().index.chats[0].sessionId, 'session-s')
  // 没有改动时重复同步不重写索引。
  await registry.sync({ id: 'chat-s', sessionId: 'session-s', cardPath: '', cardName: 'S', updatedAt: 10, createdAt: 10 })
  await registry.sync({ id: 'chat-s', sessionId: 'session-s', cardPath: '', cardName: 'S', updatedAt: 10, createdAt: 10 })
  assert.equal(store.snapshot().index.chats.length, 1)
})

test('升级期的索引新旧行混排：老行回退读盘，新行只比对字段', async function () {
  const chats = {
    'chat-old': { id: 'chat-old', sessionId: 'session-old', cardPath: '', cardName: '旧' },
    'chat-new': { id: 'chat-new', sessionId: 'session-new', cardPath: '', cardName: '新' }
  }
  // 老版本写的行没有 sessionId 列，新版本的行有。
  const store = memoryStore({ index: { chats: [{ id: 'chat-old' }, { id: 'chat-new', sessionId: 'session-new' }] }, chats })
  const registry = createTavernConversationRegistry({ store: store.adapter })

  const resolved = await registry.resolve('session-old')
  assert.equal(resolved.id, 'chat-old')
  assert.equal(store.snapshot().chatReads, 1, '老行读一次就够')
  assert.deepEqual(store.snapshot().links, { 'session-old': 'chat-old' })

  // 新行直接按列跳过，不再读文件。
  const before = store.snapshot().chatReads
  const current = await registry.resolve('session-new')
  assert.equal(current.id, 'chat-new')
  assert.equal(store.snapshot().chatReads, before + 1, '只读命中的新行')
})

test('老行同步一次后带上 session 列，之后不再重写索引', async function () {
  const chat = { id: 'chat-m', sessionId: 'session-m', cardPath: '', cardName: 'M', updatedAt: 5, createdAt: 5 }
  const store = memoryStore({ index: { chats: [{ id: 'chat-m', cardName: 'M', updatedAt: 5, createdAt: 5, lastOpenedAt: 5, cardPath: '', title: '', mode: 'story', requestMode: 'dsh' }] }, chats: { 'chat-m': chat } })
  const registry = createTavernConversationRegistry({ store: store.adapter })
  await registry.sync(chat)
  assert.equal(store.snapshot().index.chats[0].sessionId, 'session-m', '第一次同步补上新列')
  const before = JSON.stringify(store.snapshot().index)
  await registry.sync(chat)
  assert.equal(JSON.stringify(store.snapshot().index), before, '内容没变时不再重写')
})
