import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises'
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
  // 只复用外部依赖；插件入口和所有相对导入必须来自本次解包，不能回落到源码工作树。
  for (const name of await readdir(path.join(root, 'node_modules'))) {
    if (name.startsWith('.') || name === '@deepseek-ai' || name.startsWith('dsh-')) continue
    await symlink(path.join(root, 'node_modules', name), path.join(modules, name))
  }
  for (const name of ['dsh-mnemon', 'dsh-mnemon-source-runtime', 'dsh-mnemon-source-documents']) {
    await symlink(path.join(root, 'node_modules', name), path.join(modules, name))
  }
  await symlink(path.join(hostModules, '@deepseek-ai'), path.join(modules, '@deepseek-ai'))
  for (const relative of ['tavern-plugin', 'tavern-plugin/packages/dsh-asset-library', 'tavern-plugin/packages/dsh-tavern-stage']) {
    const manifest = JSON.parse(await readFile(path.join(packageDir, relative, 'package.json'), 'utf8'))
    assert.equal(boot.evaluatePluginCompatibility(manifest), undefined, manifest.name)
    const entry = path.join(packageDir, relative, 'lib/index.js')
    const imported = await import(pathToFileURL(entry))
    assert.equal(typeof imported.apply, 'function', relative)
  }
})
