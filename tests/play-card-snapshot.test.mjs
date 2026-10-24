import assert from 'node:assert/strict'
import test from 'node:test'

import { createContextPlanner } from '../tavern-plugin/lib/domain/context-planner.js'
import { createPlayCardSnapshots, cardContentDigest } from '../tavern-plugin/lib/domain/play-card-snapshots.js'

const oldChat = () => ({ id: 'chat', mode: 'story', messages: [{ text: '既有剧情' }], cardContextSnapshot: '旧前缀', cardContextSnapshotVersion: 5, _storageRevision: 7 })

test('游玩中切换画像仅修改固定前缀，保留 200 轮历史、变量与原卡背景', async () => {
  const { Session } = await import('./fixtures/dsh-session-host.mjs')
  const { ensureSessionStablePrefix, sessionStablePrefixSections } = await import('../tavern-plugin/lib/domain/session-stable-prefix.js')
  let preference = { revision: 3, text: '【用户已确认的长期偏好】\n温和叙事' }
  const snapshots = createPlayCardSnapshots({ userPreferenceProfile: { stableContext: async () => preference },
    planner: { plan: () => { throw new Error('切换画像不得重建人物卡背景') } },
    writeChat: () => { throw new Error('补丁不能直接写存档') } })
  let chat = { id: 'profile-toggle', mode: 'story', cardContextSnapshotVersion: 7, cardContextSnapshot: '【故事设定 · 人物卡】\n原卡背景\n\n【常驻世界书】\n原世界书', cardContentDigest: 'old-card',
    userProfileEnabled: false, messages: Array.from({ length: 200 }, (_, turn) => ({ turn, text: '历史' })), variables: { hp: 12 }, mvu: { enabled: true }, runtimePresetSnapshot: { id: 'preset' } }
  const original = structuredClone(chat)
  const session = Session.create('profile-toggle')
  await ensureSessionStablePrefix(session, chat.cardContextSnapshot, undefined, 0)
  const enabled = await snapshots.preferenceReplacement(chat, true)
  assert.deepEqual(chat, original)
  chat = { ...chat, ...enabled }
  await ensureSessionStablePrefix(session, chat.cardContextSnapshot, undefined, chat.cardContextRevision)
  assert.match(sessionStablePrefixSections(session).map(s => s.text).join('\n'), /温和叙事/)
  assert.equal(chat.userProfileRevision, 3)
  assert.equal(chat.cardContextRevision, 1)
  assert.equal(chat.cardContentDigest, 'old-card')
  assert.deepEqual(await snapshots.preferenceReplacement(chat, true), {}, '重复开启不破坏缓存')
  preference = { revision: 4, text: '【用户已确认的长期偏好】\n新的偏好' }
  const disabled = await snapshots.preferenceReplacement(chat, false)
  chat = { ...chat, ...disabled }
  await ensureSessionStablePrefix(session, chat.cardContextSnapshot, undefined, chat.cardContextRevision)
  assert.equal(chat.cardContextSnapshot, original.cardContextSnapshot)
  assert.doesNotMatch(sessionStablePrefixSections(session).map(s => s.text).join('\n'), /温和叙事|新的偏好/)
  assert.equal(chat.userProfileRevision, 0)
  chat = { ...chat, ...await snapshots.preferenceReplacement(chat, true) }
  assert.equal(chat.userProfileRevision, 4)
  assert.equal(chat.cardContextRevision, 3)
  for (const field of ['messages', 'variables', 'mvu', 'runtimePresetSnapshot']) assert.deepEqual(chat[field], original[field])
})

test('显式应用新版同步刷新常驻背景、MVU 规则和模板世界书，普通读取仍固定', async () => {
  const { createWorldBookLibrary } = await import('../tavern-plugin/lib/domain/worldbook-library.js')
  const { mvuUpdateRulesFromWorldBook } = await import('../tavern-plugin/lib/domain/worldbook-recall.js')
  const card = { name: '测试', character_book: { entries: [
    { id: 0, comment: '背景', content: '新版背景', constant: true, enabled: true, keys: [] },
    { id: 1, comment: '[mvu_update]变量更新规则', content: '人际关系.人际网络', constant: true, enabled: true, keys: [] }
  ] } }
  let binding = { kind: 'default' }
  const worldBooks = createWorldBookLibrary({ normalizePath: p => p, removeStandalone: async () => {},
    cards: { read: async () => card }, resources: { bindingForCard: async () => binding, readText: async () => JSON.stringify({entries:{0:{uid:0,comment:"独立世界书",content:"独立新版",constant:true,disable:false,key:[]}}}) } })
  const old = structuredClone(card.character_book)
  old.entries[0].content = '旧版背景'
  old.entries[1].content = '人际网络'
  const chat = { id: 'test', mode: 'story', cardPath: 'cards/test.json', cardContextSnapshotVersion: 7,
    cardContextSnapshot: '旧版背景', messages: [{role:'assistant',text:'历史'}], variables: {hp:12},
    openingWorldbookSnapshot: {version:1,source:{kind:'card',cardPath:'cards/test.json',cardName:card.name},document:old} }
  chat.cardContentDigest = cardContentDigest(card)
  const before = structuredClone(chat)
  const api = createPlayCardSnapshots({worldBooks, planner:createContextPlanner({prompt:()=>''}), writeChat:async()=>{throw Error('must not save')}, readCard:async()=>card})
  assert.equal(await api.ensure(chat,card),'旧版背景')
  const status = await api.updateStatus(chat, card)
  assert.equal(status.available, true)
  assert.equal(status.worldbookSyncRequired, true, '旧存档缺少原始版本时提示同步')
  const patch = await api.replacement(chat,card,status.digest)
  assert.deepEqual(chat,before)
  assert.match(patch.cardContextSnapshot,/新版背景/)
  const updated = {...chat,...patch}
  assert.match(mvuUpdateRulesFromWorldBook(await worldBooks.bound(chat.cardPath,card,updated)).join('\n'),/人际关系\.人际网络/)
  assert.match(JSON.stringify(await worldBooks.templateSnapshot(chat.cardPath,card,updated)),/人际关系\.人际网络/)
  assert.equal(patch.messages,undefined)
  assert.equal(patch.variables,undefined)
  binding = {kind:'standalone',path:'worldbooks/current.json',available:true}
  const rebound = await api.replacement(chat,card)
  assert.equal(rebound.openingWorldbookSnapshot.source.path,'worldbooks/current.json')
  assert.match(rebound.cardContextSnapshot,/独立新版/)
  binding = {kind:'standalone',path:'worldbooks/missing.json',available:false}
  await assert.rejects(api.replacement(chat,card),/世界书不存在/)
  assert.deepEqual(chat,before,'读取失败不应用部分更新')
  binding = {kind:'none'}
  const removed = await api.replacement(chat,card)
  assert.equal(removed.openingWorldbookSnapshot.document,null)
  assert.equal(await worldBooks.bound(chat.cardPath,card,{...chat,...removed}),null)
})

test('世界书自动更新：库改动下一轮进入本局，只有常驻条目变化才重建人物卡前缀', async () => {
  const { createWorldBookLibrary } = await import('../tavern-plugin/lib/domain/worldbook-library.js')
  const { worldbookContentDigest } = await import('../tavern-plugin/lib/domain/worldbook-version.js')
  const card = { name: '自动', character_book: { entries: [] } }
  const cardPath = 'cards/auto.json', bookPath = 'worldbooks/auto.json'
  const book = (background, constant) => JSON.stringify({ name: '自动世界书', entries: [
    { uid: 0, comment: '背景', content: background, constant: false, disable: false, key: ['城'] },
    { uid: 1, comment: '常驻', content: constant, constant: true, disable: false, key: [] }
  ] })
  let text = book('旧背景', '旧常驻')
  const worldBooks = createWorldBookLibrary({ normalizePath: p => p, removeStandalone: async () => {},
    cards: { read: async () => card },
    resources: { bindingForCard: async () => ({ kind: 'standalone', path: bookPath, available: true }), readText: async () => text } })
  const live = await worldBooks.bound(cardPath, card, {})
  const chat = { id: 'chat-auto', sessionId: 'session-auto', mode: 'story', cardPath,
    messages: [{ role: 'assistant', text: '历史' }], cardContextSnapshot: '【常驻世界书】\n旧常驻',
    cardContextSnapshotVersion: 7, cardContextRevision: 0, worldbookLibraryDigest: worldbookContentDigest(live),
    cardDefinitionSnapshot: { name: '自动', description: '开局时的卡' },
    openingWorldbookSnapshot: { version: 1, libraryDigest: worldbookContentDigest(live), source: live.source, document: live.document },
    preparedWorldBook: { turn: 1, refs: ['entry:1'] }, preparedWorldBookContext: '旧召回' }
  let stored = structuredClone(chat)
  const writes = [], plans = []
  const newerCard = { name: '自动', description: '后来改过的卡', character_book: card.character_book }
  const api = () => createPlayCardSnapshots({
    worldBooks, planner: { plan: async ({ card }) => { plans.push(card.description); return { text: '前缀' } } },
    readCard: async () => newerCard, writeChat: async () => { throw new Error('自动更新不能整份覆盖存档') },
    updateChat: async (id, mutate, metadata) => { writes.push(metadata.source); stored = mutate(stored); return stored }
  })
  const snapshots = api()

  assert.equal((await snapshots.autoSync(chat, newerCard)).applied, false, '库没变就不写')
  assert.deepEqual(writes, [])

  text = book('新背景', '旧常驻')
  const changed = await snapshots.autoSync(chat, newerCard)
  assert.deepEqual(writes, ['card-context.worldbook-auto'])
  assert.match(JSON.stringify(stored.openingWorldbookSnapshot.document), /新背景/)
  assert.equal(stored.worldbookLibraryDigest, worldbookContentDigest(await worldBooks.bound(cardPath, newerCard, {})))
  assert.equal(stored.preparedWorldBook, null, '下一轮的预告召回作废')
  assert.equal(stored.preparedWorldBookContext, '')
  assert.equal(stored.cardContextSnapshot, '【常驻世界书】\n旧常驻', '普通条目不影响人物卡前缀')
  assert.equal(stored.cardContextRevision, 0)
  assert.equal(changed.patch.cardContextSnapshot, undefined)
  assert.equal((await snapshots.autoSync(chat, newerCard)).applied, false, '应用一次后保持安静')
  assert.equal(writes.length, 1)
  assert.deepEqual(plans, [], '普通条目变化不调用模型')

  text = book('新背景', '新常驻')
  const constants = await snapshots.autoSync(chat, newerCard)
  assert.equal(constants.patch.cardContextSnapshot, '前缀', '常驻条目变化必须重建前缀')
  assert.equal(constants.patch.cardContextSnapshotVersion, 7)
  assert.deepEqual(plans, ['开局时的卡'], '重建前缀用开局时的卡，不偷偷带上后来的卡改动')
  assert.equal(stored.cardContextRevision, 1)
  assert.equal(writes.length, 2)

  text = book('第三版背景', '新常驻')
  assert.equal(await snapshots.autoSync({ ...chat, regenInProgress: true }, card), null, '重新生成期间不动快照')
  assert.equal(await snapshots.autoSync(chat, card, { busy: true }), null, '生成或结算期间不动快照')
  assert.equal(writes.length, 2)

  // 旧存档没有原始版本，本局快照可能已经含脚本写入，只能由用户显式同步。
  const legacy = { ...chat, worldbookLibraryDigest: undefined,
    openingWorldbookSnapshot: { ...chat.openingWorldbookSnapshot, libraryDigest: undefined } }
  assert.equal((await snapshots.autoSync(legacy, card)).applied, false)
  const legacyStatus = await snapshots.updateStatus(legacy, card)
  assert.equal(legacyStatus.worldbookSyncRequired, true)
  assert.equal(writes.length, 2)
})

test('世界书自动更新：读取失败保留本局快照，卡片工作台不参与', async () => {
  const { createWorldBookLibrary } = await import('../tavern-plugin/lib/domain/worldbook-library.js')
  const card = { name: '坏书', character_book: { entries: [] } }
  let readable = true
  const worldBooks = createWorldBookLibrary({ normalizePath: p => p, removeStandalone: async () => {},
    cards: { read: async () => card },
    resources: { bindingForCard: async () => ({ kind: 'standalone', path: 'worldbooks/broken.json', available: true }),
      readText: async () => { if (!readable) throw new Error('世界书不存在'); return JSON.stringify({ entries: {} }) } } })
  const chat = { id: 'chat-broken', sessionId: 'session-broken', mode: 'story', cardPath: 'cards/broken.json',
    openingWorldbookSnapshot: { version: 1, libraryDigest: 'old', source: { kind: 'standalone', path: 'worldbooks/broken.json' }, document: { entries: {} } } }
  let writes = 0
  const snapshots = createPlayCardSnapshots({ worldBooks, planner: { plan: async () => ({ text: '' }) }, readCard: async () => card,
    writeChat: async () => {}, updateChat: async () => { writes++; return chat } })
  readable = false
  assert.equal(await snapshots.autoSync(chat, card), null)
  assert.equal(writes, 0)
  readable = true
  assert.equal(await snapshots.autoSync({ ...chat, mode: 'card' }, card), null, '卡片工作台读的是实时卡，不需要快照')
})

test('没有本局副本的游戏，常驻条目改动在下一轮读到时重建人物卡前缀', async () => {
  const { createWorldBookLibrary } = await import('../tavern-plugin/lib/domain/worldbook-library.js')
  const card = { name: '跟随库', character_book: { entries: [] } }
  const cardPath = 'cards/follow.json', bookPath = 'worldbooks/follow.json'
  const book = constant => JSON.stringify({ name: '书', entries: [
    { uid: 0, comment: '常驻', content: constant, constant: true, disable: false, key: [] }
  ] })
  let text = book('旧常驻')
  const worldBooks = createWorldBookLibrary({ normalizePath: p => p, removeStandalone: async () => {},
    cards: { read: async () => card },
    resources: { bindingForCard: async () => ({ kind: 'standalone', path: bookPath, available: true }), readText: async () => text } })
  let stored = null
  const writes = []
  const api = createPlayCardSnapshots({ worldBooks,
    planner: { plan: async ({ worldBookContext }) => ({ text: worldBookContext.includes('新常驻') ? '前缀-新' : '前缀-旧' }) },
    readCard: async () => card, writeChat: async () => { throw new Error('自动更新不能整份覆盖存档') },
    updateChat: async (id, mutate, metadata) => { writes.push(metadata.source); stored = mutate(stored); return stored }
  })
  const chat = { id: 'follow', sessionId: 'session-follow', mode: 'story', cardPath, messages: [{ role: 'assistant', text: '开场' }] }
  await api.prepare(chat, card, await worldBooks.bound(cardPath, card, {}))
  // A new game keeps no copy: only the fixed prefix is frozen.
  assert.equal(chat.openingWorldbookSnapshot, undefined)
  assert.equal(chat.cardContextSnapshot, '前缀-旧')
  stored = structuredClone(chat)
  assert.equal((await api.autoSync(chat, card)).applied, false, '库没变就不写')
  assert.deepEqual(writes, [])
  text = book('新常驻')
  assert.equal((await api.autoSync(chat, card)).applied, true)
  assert.deepEqual(writes, ['card-context.constants'])
  assert.equal(stored.cardContextSnapshot, '前缀-新')
  assert.equal(stored.openingWorldbookSnapshot, undefined, '仍然不复制世界书')
  assert.equal(stored.cardContextRevision, 1)
  assert.equal((await api.autoSync(chat, card)).applied, false, '应用一次后保持安静')
  assert.equal(writes.length, 1)
})

test('没有本局副本的游戏也能显式重载人物卡，且不新建世界书副本 (#318)', async () => {
  const { createWorldBookLibrary } = await import('../tavern-plugin/lib/domain/worldbook-library.js')
  const entry = (id, content, enabled = true) => ({ id, comment: content, content, constant: true, enabled, keys: [] })
  let card = { name: '内嵌', character_book: { entries: [entry(0, '旧条目'), entry(1, '保留条目')] } }
  const worldBooks = createWorldBookLibrary({ normalizePath: p => p, removeStandalone: async () => {},
    cards: { read: async () => card }, resources: { bindingForCard: async () => ({ kind: 'default' }) } })
  const api = createPlayCardSnapshots({ worldBooks, planner: { plan: async ({ worldBookContext }) => ({ text: worldBookContext }) },
    readCard: async () => card, writeChat: async () => { throw new Error('不能整份覆盖存档') } })
  const chat = { id: 'follow-card', mode: 'story', cardPath: 'cards/follow.json', messages: [{ role: 'assistant', text: '开场' }] }
  await api.prepare(chat, card)
  assert.equal(chat.openingWorldbookSnapshot, undefined)
  assert.match(chat.cardContextSnapshot, /旧条目/)
  assert.equal(api.libraryBoundStatus(chat, card).available, false, '卡没变不提示')

  card = { ...card, character_book: { entries: [entry(0, '旧条目', false), entry(1, '保留条目')] }, extensions: { regex_scripts: [{ id: 'new' }] } }
  const status = api.libraryBoundStatus(chat, card)
  assert.equal(status.cardChanged, true)
  assert.equal(status.available, true)
  assert.notEqual(status.digest, '', '重载按钮必须拿得到校验值')

  const before = structuredClone(chat)
  const patch = await api.replacement(chat, card, status.digest)
  assert.deepEqual(chat, before)
  assert.equal('openingWorldbookSnapshot' in patch, false, '不为跟随库的游戏新建副本')
  assert.doesNotMatch(patch.cardContextSnapshot, /旧条目/, '卡内嵌世界书关掉的条目离开前缀')
  assert.match(patch.cardContextSnapshot, /保留条目/)
  assert.deepEqual(patch.cardDefinitionSnapshot, card)
  assert.equal(patch.cardContentDigest, cardContentDigest(card))
  assert.equal(api.libraryBoundStatus({ ...chat, ...patch }, card).available, false, '应用后不再提示')

  const stale = status.digest
  card = { ...card, name: '再改' }
  await assert.rejects(api.replacement(chat, card, stale), /人物卡已再次修改/)
})

test('重载人物卡的检测与校验值按磁盘上最新的卡算，不拿本局冻结的卡和自己比', async () => {
  const { createWorldBookLibrary } = await import('../tavern-plugin/lib/domain/worldbook-library.js')
  const entry = (id, content, enabled = true) => ({ id, comment: content, content, constant: true, enabled, keys: [] })
  const frozen = { name: '内嵌', character_book: { entries: [entry(0, '旧条目')] } }
  let latest = frozen
  const worldBooks = createWorldBookLibrary({ normalizePath: p => p, removeStandalone: async () => {},
    cards: { read: async () => latest }, resources: { bindingForCard: async () => ({ kind: 'default' }) } })
  const api = createPlayCardSnapshots({ worldBooks, planner: { plan: async ({ worldBookContext }) => ({ text: worldBookContext }) },
    readCard: async chat => chat.cardDefinitionSnapshot, readLatestCard: async () => latest,
    writeChat: async () => { throw new Error('不能整份覆盖存档') } })
  const chat = { id: 'frozen-card', mode: 'story', cardPath: 'cards/frozen.json', cardDefinitionSnapshot: frozen, messages: [{ role: 'assistant', text: '开场' }] }
  await api.prepare(chat, frozen)
  assert.equal((await api.currentStatus(chat, { busy: true })).available, false, '卡没改不提示')

  latest = { ...frozen, character_book: { entries: [entry(0, '改过的条目')] } }
  const status = await api.currentStatus(chat, { busy: true })
  assert.equal(status.cardChanged, true, '改了卡内嵌世界书要提示')
  const patch = await api.replacement(chat, latest, status.digest)
  assert.match(patch.cardContextSnapshot, /改过的条目/, '按页面拿到的校验值能重载成功')
})
