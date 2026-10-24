import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'acorn'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = name => readFileSync(path.join(root, name), 'utf8')

test('tavern-plugin 的 cordis 补丁：preset 声明行与插件入口都能解析', () => {
  // 0.2.0-rc.2 适配：preset 不再是 presets/ 下的目录（agent.cordis.yml + preset.yml），
  // 而是 bundle patch 里的 @deepseek-ai/dsh-agent-preset 声明行。声明行里 `name` 的解析基准
  // 是声明文件所在目录（profile 目录），相对路径会解析失败，因此这里只允许裸包说明符。
  const pluginPatch = read('tavern-plugin/cordis.patch.yml')
  const presetRows = pluginPatch.split('\n').filter(line => /^\s*name: '@deepseek-ai\/dsh-agent-preset'\s*$/.test(line))
  assert.equal(presetRows.length, 2, 'tavern 与 tavern-background 两个 preset 声明行必须存在')
  for (const [, specifier] of pluginPatch.matchAll(/^\s*name: (\.\.?\/\S+)\s*$/gm)) {
    assert.fail(`preset 声明行不得使用相对路径（0.2.0 的解析基准是 profile 目录）：${specifier}`)
  }
  for (const [, specifier] of pluginPatch.matchAll(/^\s*name: (dsh-tavern-plugin\/\S+)\s*$/gm)) {
    const exported = JSON.parse(read('tavern-plugin/package.json')).exports[`.${specifier.slice('dsh-tavern-plugin'.length)}`]
    assert.ok(exported, `${specifier} 未在 tavern-plugin/package.json 的 exports 中声明`)
    assert.ok(existsSync(path.join(root, 'tavern-plugin', exported)), `${specifier} 指向的文件不存在`)
  }
  parse(read('tavern-plugin/lib/client.js'), { ecmaVersion: 'latest', sourceType: 'script' })
})
