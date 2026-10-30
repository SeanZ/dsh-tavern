import test from 'node:test'
import assert from 'node:assert/strict'
import { installTavernBridge, removeMountedPicture } from '../tavern-plugin/packages/dsh-tavern-image-bundled/lib/tavern-bridge.js'

// 配图插件的生成记录与对话里的图同进同退。
const image = 'dsh-tavern-image/image'

test('设置页删图：撤下对话里同一张图的那个版本，不碰别的版本和别的媒体', async () => {
  const removed = []
  const tavern = { apiVersion: 5, remove: async (id, options) => { removed.push([id, options?.version]); return true },
    list: async () => [
      { id: 'm1', kind: image, data: { jobId: 'j3' }, history: [{ data: { jobId: 'j1' } }, { data: { jobId: 'j2' } }] },
      { id: 'm2', kind: 'other/audio', data: { jobId: 'j2' }, history: [] },
    ] }
  await removeMountedPicture(tavern, { id: 'j2', gameId: 'g' })
  await removeMountedPicture(tavern, { id: 'j3', gameId: 'g' })
  await removeMountedPicture(tavern, { id: 'j9', gameId: 'g' })
  await removeMountedPicture(tavern, { id: 'j3' })
  assert.deepEqual(removed, [['m1', 1], ['m1', 'current']])
})

test('玩家在对话里删图：删掉被删各版本的生成记录；整项没了时连还在重画的那张一起删', async () => {
  let onRemoved
  const deleted = []
  const bridge = installTavernBridge({
    tavern: { apiVersion: 5, onTurnSettled: () => () => {}, onMediaRemoved: handler => { onRemoved = handler; return () => {} } },
    attachments: {}, engine: { deleteJob: async id => { deleted.push(id) } }, getConfig: () => ({}), logger: {},
  })
  await onRemoved({ kind: 'other/image', itemRemoved: true, pictures: [{ data: { jobId: 'x' } }] })
  await onRemoved({ kind: image, itemRemoved: false, pictures: [{ data: { jobId: 'j1', replacement: { jobId: 'r1' } } }] })
  await onRemoved({ kind: image, itemRemoved: true, pictures: [{ data: { jobId: 'j1' } }, { data: { jobId: 'j2', replacement: { jobId: 'r2' } } }, {}] })
  assert.deepEqual(deleted, ['j1', 'j1', 'j2', 'r2'])
  bridge?.dispose?.()
})
