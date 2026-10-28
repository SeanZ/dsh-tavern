import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// 使用文档由社区在 Wiki 维护；仓库中的安装入口仍不能推广旧社区宿主安装包。
test('仓库安装入口不推广旧社区宿主安装器', async () => {
  const files = ['README.md', 'android/README.md']
  const names = new Set()
  for (const file of files) {
    const text = await readFile(new URL('../' + file, import.meta.url), 'utf8')
    for (const match of text.matchAll(/DSH-Tavern-Desktop-[\w.-]+-Setup[\w.-]*\.exe/g)) names.add(match[0])
  }
  assert.deepEqual([...names], [], '官方宿主分支不得继续推广旧社区宿主安装包')
})
