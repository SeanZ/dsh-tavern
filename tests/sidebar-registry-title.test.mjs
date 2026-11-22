import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

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
    // Native right-sidebar registration respects descriptor.keepMounted !== false and sets files takeover to false.
    assert.ok(source.includes('keepMounted: descriptor.keepMounted !== false'), `${file} must respect descriptor.keepMounted`)
    assert.ok(source.includes('kind: FILES_KIND,\n\t\t\t\t\t\tkeepMounted: false,'), `${file} must disable keepMounted for files takeover`)
  })
}
