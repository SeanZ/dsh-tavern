import test from 'node:test'
import assert from 'node:assert/strict'

import { isCompatibleHost } from '../bin/plugin-package-guard.mjs'

// 版本判定只会返回 allowed / blocked；guard 曾经要求一个不存在的 verified，
// 结果在任何宿主上都抛错，user-tools-bridge 与 compaction 因此永远不启动。
test('支持范围内的宿主通过 guard，范围外或读取失败拒绝', () => {
  assert.equal(isCompatibleHost({ status: 'allowed', message: '' }), true)
  assert.equal(isCompatibleHost({ status: 'verified', message: '' }), true)
  assert.equal(isCompatibleHost({ status: 'blocked', message: 'DSH 0.3.0 不在支持范围' }), false)
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

test('标准包初始化安装真实内置罗盘，同版本重启保留停用状态与插件数据', async t => {
  const { mkdtemp, readFile, writeFile, mkdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { prepareStandardPackage } = await import('../bin/plugin-package-guard.mjs')
  const home = await mkdtemp(path.join(tmpdir(), 'tavern-standard-builtins-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const root = path.join(home, 'profile-data/tavern/data')
  const [first] = await prepareStandardPackage(root)
  assert.equal(first.action, 'installed')
  const target = path.join(root, 'plugins/dsh-tavern-plot-compass')
  const manifest = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-tavern-plot-compass')
  assert.match(await readFile(path.join(target, 'lib/index.js'), 'utf8'), /export/)
  await writeFile(path.join(target, '.tavern-disabled'), '停用')
  const data = path.join(root, 'plugin-data')
  await mkdir(data, { recursive: true })
  await writeFile(path.join(data, 'kept.json'), '{"keep":true}')
  const [again] = await prepareStandardPackage(root)
  assert.equal(again.action, 'skipped')
  assert.equal(await readFile(path.join(target, '.tavern-disabled'), 'utf8'), '停用')
  assert.equal(await readFile(path.join(data, 'kept.json'), 'utf8'), '{"keep":true}')
})
