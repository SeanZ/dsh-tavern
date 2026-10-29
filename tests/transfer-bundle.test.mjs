import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTransferManifest, packTransferBundle, readTransferBundle, transferItem } from '../tavern-plugin/lib/domain/transfer-bundle.js'

function sampleBundle() {
  const card = JSON.stringify({ name: '作家', description: '写东西的人' })
  const item = transferItem({ key: 'cards/作家.json', title: '作家', entry: 'parts/cards/作家.json', content: card })
  const parts = [{ kind: 'cards', label: '人物卡', items: [item] }]
  const manifest = buildTransferManifest({ name: '我的酒馆备份', createdAt: 1792500000000, source: { tavern: '3.1.0', platform: 'linux' }, parts })
  return { manifest, files: new Map([['parts/cards/作家.json', Buffer.from(card, 'utf8')]]) }
}

test('不是导出包或版本不符时给出明确错误', () => {
  assert.throws(() => readTransferBundle(Buffer.from('not a zip')), /不是有效的 ZIP|解析失败/)
  const { manifest, files } = sampleBundle()
  const older = Object.assign({}, manifest, { version: 99 })
  const buffer = packTransferBundle({ manifest: older, files })
  assert.throws(() => readTransferBundle(buffer), /不支持的导出包版本/)
})
