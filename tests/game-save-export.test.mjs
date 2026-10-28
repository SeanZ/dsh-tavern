import test from 'node:test'
import assert from 'node:assert/strict'
import { createGameSaveExporter } from '../tavern-plugin/lib/domain/game-save-export.js'
import { createGameSaveSnapshot } from '../tavern-plugin/lib/domain/game-save-snapshot.js'
import { readGameSave } from '../tavern-plugin/lib/domain/game-save.js'
import { computeSceneTarget } from '../tavern-plugin/lib/domain/scene-illustration.js'

function fixture({ images = true, missing = false, pluginFailure = false, mutate = false, worldbook = false, boundWorldbook = worldbook, preset = false, presetPath = 'presets/play.json' } = {}) {
  const chat = { id: 'chat-a', sessionId: 'session-a', cardPath: 'cards/a.json', cardName: '卡', mode: 'script',
    _storageRevision: 2, messages: [{ role: 'assistant', turn: 1, text: '正文' }],
    cardDefinitionSnapshot: { raw: { name: '卡' } }, timeline: { checkpoints: [{ turn: 2, beforeRevision: 1 }] },
    ...(preset ? { runtimePresetPath: presetPath, runtimePresetSnapshot: { presetPath, presetName: '默认', digest: 'digest-1',
      regexScripts: [{ scriptName: '去掉括号', findRegex: '/(\\()/g', replaceString: '（' }], front: [], middle: [], back: [] } } : {}),
    ...(worldbook ? { openingWorldbookSnapshot: { version: 1, libraryDigest: 'wb-digest', source: { kind: 'standalone', path: 'worldbooks/w.json' },
      document: { name: '书', entries: { '0': { uid: 0, key: ['a'], content: '很长的一本世界书'.repeat(50) } }, extensions: {} } } } : {}) }
  const old = { ...chat, _storageRevision: 1, timeline: { checkpoints: [] } }
  const image = id => ({ attachmentId: id, mediaType: 'image/gif' })
  const session = { header: { id: 'session-a' }, inheritedEventCount: 0,
    events: [{ seq: 0, type: 'session/title', data: { title: '旧名称' } }, { seq: 1, type: 'session/title', data: { title: ' 新 / 名称 ' } },
      { seq: 2, type: 'user/message', data: { image: image('message'), repeat: image('message') } }] }
  const reads = [], warnings = []
  const key = computeSceneTarget(chat, 1).key
  const files = [{ path: 'scene.json', content: Buffer.from(JSON.stringify({ image: image('scene'), deletedVersions: [image('deleted')] })) }]
  const exporter = createGameSaveExporter({
    chatForSession: async id => id === chat.sessionId ? chat : undefined,
    gameSaveSnapshot: createGameSaveSnapshot({ readChat: async () => structuredClone(chat), readSession: async () => structuredClone(session), assertIdle() {} }),
    readChatRevision: async (id, revision) => { assert.equal(id, chat.id); assert.equal(revision, 1); return old },
    fileResources: { originalCardPayload: async () => { throw Error('source removed') }, scriptForCard: async () => 'materials/story.txt', readText: async () => '剧本' },
    gameFootprint: { readSceneFiles: async () => { assert.equal(images, true); return files } },
    sceneWorldbookArchive: { exportForSave: async states => { assert.deepEqual(states.map(s => s._storageRevision), [2, 1]); return [] } },
    getAttachments: () => ({
      readImage: async ref => { reads.push(ref.attachmentId); if (missing) throw Error('missing'); return { data: Buffer.from('GIF89a') } },
      async *readFileStream(ref) { reads.push(ref.attachmentId); yield Buffer.from('audio'); yield Buffer.from('-bytes') }
    }),
    exportPluginData: async () => {
      if (mutate) chat._storageRevision++
      if (pluginFailure) throw Error('plugin unavailable')
      return { data: { version: 1, owners: {} }, media: { version: 1, items: [
        { id: 'current', turn: 1, key, attachment: { attachmentId: 'audio', name: 'voice.mp3' } },
        { id: 'duplicate', turn: 1, key, attachment: { attachmentId: 'audio', name: 'voice.mp3' } },
        { id: 'stale', turn: 1, key: 'other-branch', attachment: image('stale') }
      ] } }
    }, tavernVersion: '3.0.1', hasBoundWorldbook: async () => boundWorldbook, warn: (...args) => warnings.push(args)
  })
  return { exporter, reads, warnings, session }
}

test('导出器打包稳定历史、快照人物卡与剧本，筛掉旧分支媒体和已删除图片', async () => {
  const { exporter, reads } = fixture()
  const result = await exporter('session-a')
  const save = readGameSave(Buffer.from(result.base64, 'base64'))
  assert.equal(result.filename, '新_名称.dshsave')
  assert.equal(result.revisions, 1)
  assert.equal(result.images, 2)
  assert.equal(save.card.payload.text, '{"name":"卡"}')
  assert.equal(save.script.text, '剧本')
  assert.deepEqual(save.revisions.map(r => r.revision), [1])
  assert.deepEqual(reads, ['message', 'scene', 'audio'])
  assert.deepEqual(save.plugins.media.items.map(item => item.id), ['current', 'duplicate'])
  assert.equal(save.plugins.attachments[0].data.toString(), 'audio-bytes')
})

test('关闭场景图片仍保留消息图片；图片和插件不可读时正文仍可导出', async () => {
  const plain = fixture({ images: false })
  const result = await plain.exporter('session-a', { images: false })
  const save = readGameSave(Buffer.from(result.base64, 'base64'))
  assert.deepEqual(plain.reads, ['message', 'audio'])
  assert.equal(result.images, 1)
  assert.equal(save.scene.files.length, 0)
  const damaged = fixture({ missing: true, pluginFailure: true })
  const recovered = await damaged.exporter('session-a')
  const recoveredSave = readGameSave(Buffer.from(recovered.base64, 'base64'))
  assert.equal(recovered.images, 0)
  assert.equal(recoveredSave.chat.messages[0].text, '正文')
  assert.equal(recoveredSave.plugins, null)
  assert.equal(damaged.warnings.length, 1)
})

test('导出期间发生存档更新时拒绝返回混合版本；未绑定会话明确报错', async () => {
  const { exporter } = fixture({ mutate: true })
  await assert.rejects(exporter('session-a'), /发生变化/)
  await assert.rejects(exporter('missing'), /没有绑定/)
})

test('同包带走世界书时不重复内嵌开局世界书；单独导出仍自带一份', async () => {
  const { exporter } = fixture({ worldbook: true })
  const selfContained = readGameSave(Buffer.from((await exporter('session-a')).base64, 'base64'))
  assert.ok(selfContained.chat.openingWorldbookSnapshot?.document, '单独导出的存档自带整本世界书')
  assert.ok(selfContained.revisions[0].state.openingWorldbookSnapshot?.document, '回退历史同样自带')

  const slim = readGameSave(Buffer.from((await exporter('session-a', { embedWorldbook: false })).base64, 'base64'))
  assert.equal(slim.chat.openingWorldbookSnapshot, undefined, '同包已带世界书时，局里不再存一份')
  assert.equal(slim.revisions[0].state.openingWorldbookSnapshot, undefined, '回退历史也不存')
  assert.ok(slim.chat.messages[0].text, '正文照旧')
  assert.ok(slim.chat.cardDefinitionSnapshot?.raw, '卡片快照照旧')
})

test('卡没有绑定世界书时，即使包里带了别的书也保留这局的快照：它是这局唯一的世界', async () => {
  const { exporter } = fixture({ worldbook: true, boundWorldbook: false })
  const save = readGameSave(Buffer.from((await exporter('session-a', { embedWorldbook: false })).base64, 'base64'))
  assert.ok(save.chat.openingWorldbookSnapshot?.document)
  assert.ok(save.revisions[0].state.openingWorldbookSnapshot?.document)
})

test('同包带走预设时存档不再内嵌预设快照，但保留 runtimePresetPath 供导入重新冻结', async () => {
  const { exporter } = fixture({ preset: true })
  const full = readGameSave(Buffer.from((await exporter('session-a')).base64, 'base64'))
  assert.ok(full.chat.runtimePresetSnapshot?.regexScripts, '单独导出照旧自带快照')

  const slim = readGameSave(Buffer.from((await exporter('session-a', { embedPreset: false })).base64, 'base64'))
  assert.equal(slim.chat.runtimePresetSnapshot, undefined)
  assert.equal(slim.chat.runtimePresetPath, 'presets/play.json', '记住这局用的是哪份预设')
  assert.equal(slim.revisions[0].state.runtimePresetSnapshot, undefined, '回退历史也不存')

  // 没有记下预设路径的局，导入端无从重新冻结，快照就必须留着。
  const noPath = fixture({ preset: true, presetPath: '' })
  const kept = readGameSave(Buffer.from((await noPath.exporter('session-a', { embedPreset: false })).base64, 'base64'))
  assert.ok(kept.chat.runtimePresetSnapshot)
})
