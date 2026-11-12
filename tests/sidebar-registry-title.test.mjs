import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { sourceFunction } from './fixtures/source-function.mjs'

// 标准插件实际加载内嵌侧栏，检查交付文件而非开发用外置包。
const installed = fileURLToPath(new URL('../tavern-plugin/packages/dsh-better-sidebar', import.meta.url))
const clients = ['client.js', 'client-registry.js']
const rule = 'const title = descriptor?.single === true ? titleOf(descriptor) : record?.tab.title ?? nativeTab.title;'

for (const file of clients) {
  test(`open single-panel tabs read their title from the panel registry (${file})`, async () => {
    const source = await readFile(path.join(installed, 'lib', file), 'utf8')
    const adapter = source.lastIndexOf('const nativeTab = info.tab;')
    assert.ok(adapter > 0)
    const block = source.slice(adapter, source.indexOf('const path = ', adapter))
    // A renamed panel must not keep the title its tab record stored when it was opened.
    assert.ok(block.includes(rule), block)
    assert.ok(block.indexOf('const descriptor = ') < block.indexOf(rule))
  })
}


test('侧栏标题生成补丁幂等，单页改名不沿用旧标签', async () => {
  const source = await readFile(new URL('../bin/vendor-plugin-package.mjs', import.meta.url), 'utf8')
  const patch = vm.runInNewContext(sourceFunction(source, 'patchSidebarTitle') + '; patchSidebarTitle')
  const original = '\t\t\tconst title = record?.tab.title ?? nativeTab.title;\n\t\t\tconst descriptor = service.getTab(descriptorId) ?? service.getTab(record?.tab.type ?? nativeTab.kind);'
  const transformed = patch(original)
  assert.equal(patch(transformed), transformed)
  const title = (single) => vm.runInNewContext(transformed + '; title', {
    record: { tab: { title: '旧标题' } }, nativeTab: {}, descriptorId: 'page',
    service: { getTab: () => ({ single, title: '新标题' }) }, titleOf: item => item.title
  })
  assert.equal(title(true), '新标题')
  assert.equal(title(false), '旧标题')
  assert.throws(() => patch('changed'), /锚点已变化/)
})
