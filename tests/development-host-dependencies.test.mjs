import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../tavern-plugin/package.json', import.meta.url))
const modules = fileURLToPath(new URL('../node_modules/', import.meta.url))

test('开发宿主从正式 node_modules 解析，不借用验收运行时', () => {
  for (const name of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-app-boot']) {
    assert.ok(realpathSync(require.resolve(name)).startsWith(modules), name)
  }
})

test('独立安装的开发依赖可以冷加载 Tavern 服务端', async () => {
  const plugin = await import('../tavern-plugin/lib/index.js')
  assert.equal(typeof plugin.apply, 'function')
})
