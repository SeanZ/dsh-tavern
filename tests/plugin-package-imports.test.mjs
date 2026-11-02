import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

test('实际标准 tgz 的三个服务端入口可冷导入，兼容声明无需豁免', { timeout: 60000 }, async t => {
  assert.ok(process.env.DSH_BOOT_MODULE, '需要实际宿主加载器')
  const bootFile = await realpath(process.env.DSH_BOOT_MODULE)
  const hostModules = path.resolve(path.dirname(bootFile), '../../..')
  const boot = await import(pathToFileURL(bootFile))
  const temp = await mkdtemp(path.join(tmpdir(), 'tavern-packed-imports-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], {
    cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  }))
  execFileSync('tar', ['-xzf', path.join(temp, packed.filename), '-C', temp])
  const packageDir = path.join(temp, 'package')
  const modules = path.join(packageDir, 'node_modules')
  await mkdir(modules)
  // 仅连接标准包声明的生产依赖，开发依赖不能遮蔽漏声明。
  const rootManifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'))
  for (const name of Object.keys(rootManifest.dependencies || {})) {
    const target = path.join(modules, name)
    await mkdir(path.dirname(target), { recursive: true })
    await symlink(path.join(root, 'node_modules', name), target)
  }
  await symlink(path.join(hostModules, '@deepseek-ai'), path.join(modules, '@deepseek-ai'))
  for (const relative of ['tavern-plugin', 'tavern-plugin/packages/dsh-asset-library', 'tavern-plugin/packages/dsh-tavern-stage']) {
    const manifest = JSON.parse(await readFile(path.join(packageDir, relative, 'package.json'), 'utf8'))
    assert.equal(boot.evaluatePluginCompatibility(manifest), undefined, manifest.name)
    const entry = path.join(packageDir, relative, 'lib/index.js')
    const imported = await import(pathToFileURL(entry))
    assert.equal(typeof imported.apply, 'function', relative)
    if (manifest.name === 'dsh-tavern-stage') {
      let loaded = false, disposed = false, cleanup
      await imported.apply({
        get: () => ({ install: async load => { const runtime = await load(); assert.equal(typeof runtime.createStageRuntime, 'function'); loaded = true }, uninstall: () => { disposed = true } }),
        effect: factory => { cleanup = factory() }
      })
      assert.equal(loaded, true, '执行 apply 触发舞台懒加载；完整组件初始化另由实际宿主验证')
      cleanup()
      assert.equal(disposed, true)
    }
  }
})
