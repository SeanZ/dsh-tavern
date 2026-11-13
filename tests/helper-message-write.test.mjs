import assert from 'node:assert/strict'
import test from 'node:test'
import { createHelperChatDataHost } from './fixtures/helper-chat-data-host.mjs'
import { createTavernScriptHostAdapter } from '../tavern-plugin/lib/domain/tavern-script-host-adapter.js'
import { captureHelperMessageWrite, commitHelperMessageWrite } from '../tavern-plugin/lib/domain/helper-message-write.js'

const initial = score => ({ stat_data: { score }, schema: { type: 'object' }, initialized_lorebooks: { card: [] } })

async function setup(t, concurrent = () => {}) {
  const host = await createHelperChatDataHost()
  t.after(host.cleanup)
  await host.persistence.update('audit', chat => ({ ...chat,
    mvu: { enabled: true, owner: 'official', openingInitialization: { version: 2, status: 'pending' } },
    messages: [{ ...chat.messages[0], text: '开场甲', sourceText: '开场甲', swipes: ['开场甲', '开场乙'], variables: [] }]
  }))
  let races = 0, commits = 0
  const adapter = createTavernScriptHostAdapter({
    resolveChat: id => host.persistence.read(id), readCard: async () => ({}), worldBooks: {}, scriptDispatch: {},
    writeChat() { assert.fail('正式消息写入必须走字段事务') },
    replyRegexScripts: async () => {
      if (races++ === 0) await concurrent(host)
      return []
    },
    patchChat: (...args) => { commits++; return host.persistence.patch(...args) },
  })
  return { ...host, adapter, commits: () => commits,
    initialize: () => adapter.updateMessages('audit', [{ message_id: 0, swipes_data: [initial(120), initial(70)] }], 2) }
}

test('MVU所有开场变量与完成标记原子保存，模板元数据并发保留，冷读与重复写不累加', async t => {
  const run = await setup(t, host => host.persistence.update('audit', chat => {
    chat.messages[0].tavernPluginData = { is_ejs_processed: [true], template_rendered: { hash: 'rendered' } }
    return chat
  }))
  const result = await run.initialize()
  assert.equal(result.updated, true)
  let saved = await run.open().read('audit')
  assert.equal(saved.mvu.openingInitialization.status, 'complete')
  assert.deepEqual(saved.messages[0].variables, [initial(120), initial(70)])
  assert.deepEqual(saved.messages[0].tavernPluginData, { is_ejs_processed: [true], template_rendered: { hash: 'rendered' } })
  assert.equal(run.commits(), 2)
  await run.initialize()
  saved = await run.open().read('audit')
  assert.deepEqual(saved.messages[0].variables, [initial(120), initial(70)])
  assert.equal(saved.messages[0].text, '开场甲')
})

test('不同变量字段并发写入可以合并', async t => {
  const run = await setup(t, host => host.persistence.update('audit', chat => {
    chat.messages[0].variables[0].stat_data.other = 5
    return chat
  }))
  await run.persistence.update('audit', chat => {
    chat.messages[0].variables = [{ ...initial(1), stat_data: { score: 1, other: 0 } }]
    return chat
  })
  await run.adapter.updateMessages('audit', [{ message_id: 0, data: { ...initial(2), stat_data: { score: 2, other: 0 } } }], 2)
  assert.deepEqual((await run.open().read('audit')).messages[0].variables[0].stat_data, { score: 2, other: 5 })
})

for (const [name, mutate] of [
  ['同一变量', chat => { chat.messages[0].variables = [initial(999), initial(70)] }],
  ['正文', chat => { chat.messages[0].text = '并发编辑正文' }],
  ['候选选择', chat => { chat.messages[0].swipeId = 1 }],
  ['候选内容', chat => { chat.messages[0].swipes[1] = '并发修改候选' }],
  ['消息身份', chat => { chat.messages[0].messageUid = 'replacement' }],
  ['分叉身份', chat => { chat.timeline.branchId = 'different-branch' }],
  ['角色卡', chat => { chat.cardPath = 'another-card.json' }],
  ['撤回楼层', chat => { chat.messages = [] }],
]) test(`初始化拒绝${name}变化，不提交变量或完成标记`, async t => {
  const run = await setup(t, host => host.persistence.update('audit', chat => { mutate(chat); return chat }))
  await assert.rejects(run.initialize(), { code: 'DSH_TAVERN_CHAT_CONFLICT' })
  const saved = await run.open().read('audit')
  assert.equal(saved.mvu.openingInitialization.status, 'pending')
  assert.deepEqual(saved.messages[0]?.variables ?? [], name === '同一变量' ? [initial(999), initial(70)] : [])
})

test('连续CAS竞争只尝试三次，失败时不留下部分变量或完成标记', async t => {
  const run = await setup(t)
  const chat = await run.persistence.read('audit')
  const baseline = captureHelperMessageWrite(chat, [{ message_id: 0 }])
  chat.messages[0].variables = [initial(120), initial(70)]
  chat.mvu.openingInitialization = { version: 2, status: 'complete', completedAt: 123 }
  let attempts = 0
  await assert.rejects(commitHelperMessageWrite({ baseline, chat,
    resolveChat: () => run.persistence.read('audit'), assertCurrent() {},
    async patchChat(...args) {
      attempts++
      await run.persistence.update('audit', current => {
        current.messages[0].tavernPluginData = { revision: attempts }
        return current
      })
      return run.persistence.patch(...args)
    }
  }), { code: 'DSH_TAVERN_CHAT_CONFLICT' })
  assert.equal(attempts, 3)
  const saved = await run.open().read('audit')
  assert.deepEqual(saved.messages[0].variables, [])
  assert.equal(saved.mvu.openingInitialization.status, 'pending')
  assert.equal(saved.messages[0].tavernPluginData.revision, 3)
})

test('生命周期变化沿用stale协议，不覆盖重置后的开场', async t => {
  const run = await setup(t, host => host.persistence.update('audit', chat => { chat.tavernHelperLifecycleRevision++; return chat }))
  const result = await run.initialize()
  assert.equal(result.stale, true)
  const saved = await run.open().read('audit')
  assert.equal(saved.mvu.openingInitialization.status, 'pending')
  assert.deepEqual(saved.messages[0].variables, [])
})

test('同一开场等价并发初始化保留已提交完成时间', async t => {
  const run = await setup(t, host => host.persistence.update('audit', chat => {
    chat.messages[0].variables = [initial(120), initial(70)]
    chat.mvu.openingInitialization = { version: 2, status: 'complete', completedAt: 123 }
    return chat
  }))
  await run.initialize()
  const saved = await run.open().read('audit')
  assert.equal(saved.mvu.openingInitialization.completedAt, 123)
  assert.deepEqual(saved.messages[0].variables, [initial(120), initial(70)])
})
