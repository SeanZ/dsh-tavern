import test from 'node:test'
import assert from 'node:assert/strict'

import { isCompatibleHost } from '../bin/plugin-package-guard.mjs'

// 版本判定只会返回 allowed / blocked；guard 曾经要求一个不存在的 verified，
// 结果在任何宿主上都抛错，user-tools-bridge 与 compaction 因此永远不启动。
test('允许清单内的宿主通过 guard，清单外或读取失败拒绝', () => {
  assert.equal(isCompatibleHost({ status: 'allowed', message: '' }), true)
  assert.equal(isCompatibleHost({ status: 'verified', message: '' }), true)
  assert.equal(isCompatibleHost({ status: 'blocked', message: 'DSH 0.2.2 不在允许清单' }), false)
})

// #294：`dsh plugin` 安装时没有 dsh-tavern-plugin 这个包，标准插件包里的每个入口
// （包括预设自己的插件行）都必须指向包内路径，否则 user-tools 与 compaction 解析不到。
test('标准插件包里不再有指向 dsh-tavern-plugin 的裸包名', async () => {
  const { readFile } = await import('node:fs/promises')
  const patch = await readFile(new URL('../plugin.patch.yml', import.meta.url), 'utf8')
  const names = patch.split('\n').filter(line => !line.trimStart().startsWith('#')).filter(line => /\bname:\s*dsh-tavern-plugin\b/.test(line))
  assert.deepEqual(names, [])
})

// guard 实际读取当前宿主：baseline 0.2.1-rc.3 必须通过（需 DSH_BOOT_MODULE 指向 rc.3 宿主时才有意义）。
test('guard 对实际解析到的宿主判定为兼容', async () => {
  const { readHostCompatibility } = await import('../tavern-plugin/lib/domain/host-compatibility.js')
  const compatibility = readHostCompatibility()
  if (!compatibility.version) return
  assert.equal(isCompatibleHost(compatibility), true, compatibility.message)
})
