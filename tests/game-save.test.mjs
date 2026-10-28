import test from 'node:test'
import assert from 'node:assert/strict'
import { GAME_SAVE_LIMITS, buildGameSave, collectSaveRevisions, readGameSave } from '../tavern-plugin/lib/domain/game-save.js'
import { writeZipEntries } from '../tavern-plugin/lib/domain/zip-entries.js'

const bigCard = { raw: { data: { name: '卡', description: 'x'.repeat(200000) } } }
function state(revision, checkpoints = []) {
  return { id: 'chat-a', sessionId: 'session-a', cardPath: 'cards/a.json', cardName: '卡', mode: 'story', _storageRevision: revision,
    cardDefinitionSnapshot: bigCard, messages: [{ role: 'assistant', turn: 1, text: '第' + revision + '版' }],
    timeline: { checkpoints: checkpoints.map(beforeRevision => ({ turn: beforeRevision + 1, beforeRevision })) } }
}

test('导出带上回退链上的全部历史状态，大快照只存一份，读回与原状态一致', async () => {
  const states = new Map([[3, state(3, [1])], [1, state(1)], [7, state(7, [3, 5])], [5, state(5)]])
  const current = state(9, [7])
  const reads = []
  const revisions = await collectSaveRevisions(current, async (id, revision) => { reads.push(revision); return states.get(revision) })
  assert.deepEqual(revisions.map(item => item.revision), [1, 3, 5, 7])
  const session = { header: { id: 'session-a', cwd: '/old/data/resources' }, inheritedEventCount: 0, events: [{ seq: 0, type: 'turn/start', data: { turn: 1 } }] }
  const buffer = buildGameSave({ chat: current, revisions, session, card: { path: current.cardPath, payload: { kind: 'text', name: 'a.json', text: '{}' } },
    scene: { files: [{ path: 'k.json', content: Buffer.from('{"key":"k"}') }], worldbooks: [], attachments: [{ attachmentId: 'sha256:x', mediaType: 'image/png', data: Buffer.from([1, 2]) }] },
    tavernVersion: '2.5.0', exportedAt: 1 })
  assert.ok(buffer.length < 200000 * 2, '五个状态共用一份 200KB 的卡片快照：' + buffer.length)
  const read = readGameSave(buffer, { tavernVersion: '2.5.0' })
  assert.deepEqual(read.chat, current)
  assert.deepEqual(read.revisions.map(item => item.state), [1, 3, 5, 7].map(revision => states.get(revision)))
  assert.deepEqual(read.session, session)
  assert.equal(read.card.payload.name, 'a.json')
  assert.deepEqual([...read.scene.attachments[0].data], [1, 2])
  assert.equal(read.manifest.source.turns, 1)
  assert.throws(() => readGameSave(buffer, { tavernVersion: '2.4.9' }), /更新版本的酒馆/)
  assert.throws(() => readGameSave(writeZipEntries([{ path: 'manifest.json', content: '{"format":"other"}' }])), /不是 DSH Tavern 存档包/)
})

test('存档包带上插件数据、媒体与其文件；旧存档包没有插件数据时读出 null', () => {
  const current = state(2)
  const session = { header: { id: 'session-a' }, inheritedEventCount: 0, events: [] }
  const plugins = { data: { version: 1, owners: { p: { turns: [{ turn: 1, key: 'k1', data: { hp: 3 } }], game: { level: 2 } } } },
    media: { version: 1, items: [{ id: 'm', owner: 'p', turn: 1, key: 'k1', kind: 'audio', attachment: { attachmentId: 'f1', name: 'bgm.mp3', bytes: 3 } }], issued: {} },
    attachments: [{ attachmentId: 'f1', name: 'bgm.mp3', data: Buffer.from([7, 8, 9]) }] }
  const read = readGameSave(buildGameSave({ chat: current, revisions: [], session, plugins, tavernVersion: '2.5.0', exportedAt: 1 }))
  assert.equal(read.manifest.contents.plugins, true)
  assert.deepEqual(read.plugins.data, plugins.data)
  assert.deepEqual(read.plugins.media, plugins.media)
  assert.equal(read.plugins.attachments[0].name, 'bgm.mp3')
  assert.deepEqual([...read.plugins.attachments[0].data], [7, 8, 9])
  assert.equal(readGameSave(buildGameSave({ chat: current, revisions: [], session, tavernVersion: '2.5.0', exportedAt: 1 })).plugins, null)
})

test('导出时跳过已清理的早期历史版本', async () => {
  const current = { id: 'c', _storageRevision: 9, timeline: { checkpoints: [{ beforeRevision: 3 }, { beforeRevision: 7 }] } }
  const revisions = await collectSaveRevisions(current, async (id, revision) => {
    if (revision === 3) throw Object.assign(new Error('gone'), { code: 'DSH_TAVERN_REVISION_NOT_FOUND' })
    return { id, _storageRevision: revision }
  })
  assert.deepEqual(revisions.map(item => item.revision), [7])
})


test('导出拒绝读回不支持的存档大小，不返回无法导入的备份，并说明各部分大小', async () => {
  const { randomBytes } = await import('node:crypto')
  const limits = { maxArchiveBytes: 2 * 1024 * 1024, maxExpandedBytes: 6 * 1024 * 1024 }
  const input = { chat: { id: 'c', sessionId: 's', messages: [] }, revisions: [], session: { events: [] }, tavernVersion: '2.7.0',
    scene: { files: [], worldbooks: [], attachments: [{ attachmentId: 'a', mediaType: 'image/png', data: randomBytes(3 * 1024 * 1024) }] } }
  assert.throws(() => buildGameSave(input, limits), /存档包有 [0-9]+ MB，超过 2 MB（图片 3\.0 MB，/)
  const block = Buffer.alloc(3 * 1024 * 1024)
  input.scene.attachments = [1, 2, 3].map(id => ({ attachmentId: String(id), data: block }))
  assert.throws(() => buildGameSave(input, limits), /解压后 [0-9]+ MB，超过 6 MB（图片 9\.0 MB，/)
  input.scene.attachments = [{ attachmentId: 'small', data: Buffer.from('small') }]
  assert.equal(readGameSave(buildGameSave(input, limits), { limits }).scene.attachments[0].data.toString(), 'small')
})

test('存档包上限比其他压缩包宽', () => {
  assert.equal(GAME_SAVE_LIMITS.maxArchiveBytes, 256 * 1024 * 1024)
  assert.equal(GAME_SAVE_LIMITS.maxExpandedBytes, 1024 * 1024 * 1024)
})

test('长回退历史里重复的消息只存一份，存档大小不随回退点数成倍增长', () => {
  const message = turn => ({ role: 'assistant', turn, text: '第' + turn + '回合。' + '正文'.repeat(800), variables: { hp: turn, bag: ['剑'.repeat(600)] } })
  const at = turns => ({ id: 'chat-a', sessionId: 'session-a', _storageRevision: turns, cardDefinitionSnapshot: bigCard, messages: Array.from({ length: turns }, (_, index) => message(index + 1)), timeline: { checkpoints: [] } })
  const revisions = Array.from({ length: 200 }, (_, index) => ({ revision: index + 1, state: at(index + 1) }))
  const chat = at(201)
  const raw = [chat, ...revisions.map(item => item.state)].reduce((size, value) => size + JSON.stringify(value).length, 0)
  const buffer = buildGameSave({ chat, revisions, session: { events: [] }, tavernVersion: '2.5.0', exportedAt: 1 })
  const files = readGameSave(buffer)
  assert.deepEqual(files.chat, chat)
  assert.deepEqual(files.revisions, revisions)
  assert.equal(files.manifest.formatVersion, 2)
  // 201 个状态原样几百 MB，几乎全是重复；去重后压缩包约 120 KB。
  assert.ok(raw > 80 * 1024 * 1024, '原始体量：' + raw)
  assert.ok(buffer.length < 1024 * 1024, '压缩包：' + buffer.length)
})

test('第 1 版存档包（只共享顶层大字段）仍能读回', () => {
  const blob = JSON.stringify(bigCard)
  const { createHash } = globalThis.process.getBuiltinModule('node:crypto')
  const id = createHash('sha256').update(blob).digest('hex')
  const current = state(2)
  const manifest = { format: 'dsh-tavern-save', formatVersion: 1, tavernVersion: '2.5.0', exportedAt: 1,
    source: { chatId: 'chat-a', cardPath: 'cards/a.json' }, contents: { revisions: [], card: false, script: false, sceneImages: false, attachments: 0 } }
  const buffer = writeZipEntries([{ path: 'manifest.json', content: JSON.stringify(manifest) },
    { path: 'chat/current.json', content: JSON.stringify({ ...current, cardDefinitionSnapshot: { $dshSaveBlob: id } }) },
    { path: 'session/foreground.json', content: '{"events":[]}' }, { path: 'blobs/' + id + '.json', content: blob }])
  assert.deepEqual(readGameSave(buffer).chat, current)
})
