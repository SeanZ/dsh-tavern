import assert from 'node:assert/strict'
import test from 'node:test'

import { autoReloadable, createCardAutoReload } from '../tavern-plugin/lib/domain/card-auto-reload.js'

const changed = { available: true, cardChanged: true, worldbookChanged: false, digest: 'd1' }

test('人物卡或世界书有变化就自动重新加载；旧存档要同步、检查出错时不自动', () => {
  assert.equal(autoReloadable(changed), true)
  assert.equal(autoReloadable({ ...changed, cardChanged: false, worldbookChanged: true }), true)
  assert.equal(autoReloadable({ ...changed, worldbookSyncRequired: true }), false)
  assert.equal(autoReloadable({ ...changed, legacy: true }), false)
  assert.equal(autoReloadable({ ...changed, error: '读不到' }), false)
  assert.equal(autoReloadable({ available: false, digest: 'd1' }), false)
})

test('同一局一次只跑一个；失败后同一版本不反复重试，换了版本或手动重试再跑', async () => {
  const tasks = [], applied = [], published = []
  let fail = true
  const reload = createCardAutoReload({
    apply: async (sessionId, digest) => { applied.push(digest); if (fail) throw new Error('冲突') },
    published: sessionId => published.push(sessionId),
    logger: { warn() {} },
    defer: task => tasks.push(task)
  })
  assert.equal(reload.schedule('s', changed), true)
  assert.equal(reload.schedule('s', changed), false, '正在跑就不重复排')
  await tasks.shift()()
  assert.equal(reload.failure('s'), '冲突')
  assert.equal(reload.schedule('s', changed), false, '同一版本失败过就不再自动重试')
  assert.equal(reload.schedule('s', { ...changed, digest: 'd2' }), true, '卡又改了就再试')
  fail = false
  await tasks.shift()()
  assert.deepEqual(applied, ['d1', 'd2'])
  assert.deepEqual(published, ['s'], '成功后通知页面刷新')
  assert.equal(reload.failure('s'), '')
  reload.retry('s')
  assert.equal(reload.schedule('s', changed), true)
})
