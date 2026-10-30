import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { createTransferMaterials } from '../tavern-plugin/lib/domain/transfer-materials.js'

// 内存版资源库：list 按 keys 给相对路径，readText 读 files，importText 按 unique 换号写回。
function memoryResources(seed = {}, extraKeys = []) {
  const files = new Map(Object.entries(seed))
  const keys = [...Object.keys(seed), ...extraKeys]
  const calls = []
  return {
    calls,
    files,
    async list(kind) {
      calls.push({ method: 'list', kind })
      return [...keys]
    },
    async readText(relative) {
      calls.push({ method: 'readText', relative })
      return files.has(relative) ? files.get(relative) : undefined
    },
    async importText(kind, entry, cardPath, options) {
      calls.push({ method: 'importText', kind, name: entry && entry.name, text: entry && entry.text, cardPath, options })
      const name = String(entry && entry.name)
      let target = (kind === 'source' ? 'materials/' : kind + '/') + name
      if (options && options.unique === true) {
        const parsed = path.posix.parse(target)
        for (let suffix = 1; files.has(target); suffix += 1) {
          target = path.posix.join(parsed.dir, parsed.name + ' (' + suffix + ')' + parsed.ext)
        }
      }
      files.set(target, String(entry && entry.text))
      return target
    }
  }
}

test('list 列出 materials 下的素材，读不到的跳过', async () => {
  const resources = memoryResources({
    'materials/世界设定.md': '# 世界\n魔法学院\n',
    'materials/剧情大纲.txt': '第一幕\n'
  }, ['materials/读不到.txt'])
  const transfer = createTransferMaterials({ fileResources: resources })

  const rows = await transfer.list()

  assert.equal(resources.calls[0].kind, 'source')
  assert.deepEqual(rows.map(row => row.key), ['materials/世界设定.md', 'materials/剧情大纲.txt'])
  assert.deepEqual(rows.map(row => row.title), ['世界设定', '剧情大纲'])
  assert.deepEqual(rows.map(row => row.meta), ['资料', '资料'])
  assert.deepEqual(rows.map(row => row.bytes), [
    Buffer.byteLength('# 世界\n魔法学院\n'),
    Buffer.byteLength('第一幕\n')
  ])
})

test('collect 未知或读不到的路径报「剧本素材不存在」', async () => {
  const resources = memoryResources({
    'materials/剧情大纲.txt': '第一幕\n'
  }, ['materials/读不到.txt'])
  const transfer = createTransferMaterials({ fileResources: resources })

  await assert.rejects(() => transfer.collect(['materials/不存在.txt']), /剧本素材不存在：materials\/不存在\.txt/)
  await assert.rejects(() => transfer.collect(['materials/读不到.txt']), /剧本素材不存在：materials\/读不到\.txt/)
  await assert.rejects(() => transfer.collect(['materials/剧情大纲.txt', 'materials/不存在.txt']), /剧本素材不存在：materials\/不存在\.txt/)
})

test('importOne 写入素材并返回路径，同名走 unique 不覆盖', async () => {
  const resources = memoryResources({ 'materials/旧素材.txt': '原有内容\n' })
  const transfer = createTransferMaterials({ fileResources: resources })

  const first = await transfer.importOne({ title: '新素材', content: Buffer.from('第一段\n', 'utf8') })
  assert.deepEqual(first, { path: 'materials/新素材.txt' })
  assert.equal(resources.files.get('materials/新素材.txt'), '第一段\n')

  const second = await transfer.importOne({ title: '新素材', content: new Uint8Array(Buffer.from('第二段\n', 'utf8')) })
  assert.deepEqual(second, { path: 'materials/新素材 (1).txt' })
  assert.equal(resources.files.get('materials/新素材 (1).txt'), '第二段\n')

  const third = await transfer.importOne({ title: '新素材.txt', content: '第三段\n' })
  assert.deepEqual(third, { path: 'materials/新素材 (2).txt' })
  assert.equal(resources.files.get('materials/新素材 (2).txt'), '第三段\n')

  // 原素材与第一次导入的内容都没被覆盖，非法字符也不会进文件名。
  assert.equal(resources.files.get('materials/旧素材.txt'), '原有内容\n')
  assert.equal(resources.files.get('materials/新素材.txt'), '第一段\n')
  const fourth = await transfer.importOne({ title: '第一幕:开场?.md', content: Buffer.from('开场\n', 'utf8') })
  assert.deepEqual(fourth, { path: 'materials/第一幕_开场_.md' })

  const imports = resources.calls.filter(call => call.method === 'importText')
  assert.equal(imports.length, 4)
  for (const call of imports) {
    assert.equal(call.kind, 'source')
    assert.equal(call.cardPath, undefined)
    assert.deepEqual(call.options, { unique: true })
  }
})
