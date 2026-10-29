import test from 'node:test'
import assert from 'node:assert/strict'
import { createOpeningPreparation } from '../tavern-plugin/lib/domain/opening-preparation.js'

const card = { name: '测试', first_mes: '首页', alternate_greetings: ['第二幕'] }

async function draft(settings = { runtime: true }) {
  const service = createOpeningPreparation({ readCard: async () => card, worldBooks: { bound: async () => null } })
  return { service, draft: await service.create('card', settings) }
}

test('准备页的 createChatMessages 把脚本书写的楼层留在草稿里', async () => {
  const { service, draft: prepared } = await draft()
  const created = await service.callRuntime(prepared.id, 'createTavernHelperMessages', {
    messages: [{ role: 'system', message: '旧日余烬' }, { role: 'assistant', message: '风起于青萍', name: '旁白', data: { scene: 1 } }],
    option: {}
  })
  assert.equal(created.updated, true)
  assert.deepEqual(created.targets, [{ messageId: 1 }, { messageId: 2 }])
  assert.equal(created.context.messages.length, 3)
  assert.equal(created.context.messages[1].role, 'system')
  assert.equal(created.context.messages[1].message, '旧日余烬')
  assert.equal(created.context.messages[2].role, 'assistant')
  assert.equal(created.context.messages[2].name, '旁白')
  assert.deepEqual(created.context.messages[2].variables, { scene: 1 })
  assert.equal(created.context.stateRevision, 2)

  const resolved = service.resolve(prepared.id, 'card')
  assert.equal(resolved.preparedMessages.length, 2)
  assert.equal(resolved.preparedMessages[0].role, 'tavern-helper')
  assert.equal(resolved.preparedMessages[0].tavernRole, 'system')
  assert.equal(resolved.preparedMessages[0].projectionText, '旧日余烬')
  await service.release(prepared.id)
})

test('单独 /send 只记录文本，/trigger 才落成开局命令', async () => {
  const { service, draft: prepared } = await draft()
  const deferred = await service.callRuntime(prepared.id, 'prepareOpeningCommand', { line: '/send 我推门而入' })
  assert.deepEqual([deferred.deferred, deferred.input], [true, ''])
  assert.equal(service.resolve(prepared.id, 'card').startCommand, undefined, '记录文本不等于开局')
  // 两步之间卡会保存自己的数据，草稿必须照常接受
  const context = (await service.callRuntime(prepared.id, 'updateTavernHelperVariables', { option: { type: 'chat' }, variables: { chapter: 1 } })).context
  const saved = await service.callRuntime(prepared.id, 'saveTavernChatData', { request: {
    chatId: context.chatId, lifecycleRevision: context.lifecycleRevision, messages: [],
    metadata: { stateRevision: context.stateRevision, data: { demo: { seen: 1 } } }
  } })
  assert.deepEqual(saved.context.chatMetadata, { demo: { seen: 1 } })
  assert.deepEqual(await service.callRuntime(prepared.id, 'prepareOpeningCommand', { line: '/trigger' }), { deferred: false, input: '我推门而入' })
  const resolved = service.resolve(prepared.id, 'card')
  assert.equal(resolved.startCommand.input, '我推门而入')
  assert.deepEqual(resolved.chatPluginMetadata, { demo: { seen: 1 } })
  await service.release(prepared.id)
})
