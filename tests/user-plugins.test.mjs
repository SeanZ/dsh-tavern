import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'
import { pathToFileURL } from 'node:url'
import { syncPatchText, syncUserPlugins, userPluginPaths } from '../tavern-plugin/lib/domain/user-plugins.js'

async function home(t) {
  const dshHome = await mkdtemp(path.join(tmpdir(), 'user-plugins-'))
  t.after(() => rm(dshHome, { recursive: true, force: true }))
  const dataRoot = path.join(dshHome, 'profile-data', 'tavern', 'data')
  const profile = path.join(dshHome, 'profiles', 'tavern')
  await mkdir(profile, { recursive: true })
  await writeFile(path.join(profile, 'package.json'), '{}')
  return { dshHome, dataRoot, profile }
}

async function plugin(dataRoot, folder, pkg, files = { 'index.mjs': 'export function apply() {}\n' }) {
  const dir = path.join(dataRoot, 'plugins', folder)
  await mkdir(dir, { recursive: true })
  if (pkg) await writeFile(path.join(dir, 'package.json'), JSON.stringify({ version: '1.0.0', ...pkg }))
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text)
  return dir
}

test('plugins 目录里的插件写进 profile patch，用户自己的条目原样保留', async t => {
  const { dataRoot, profile } = await home(t)
  const patch = path.join(profile, 'cordis.patch.yml')
  await writeFile(patch, '# 我的覆盖\n- id: approval\n  config:\n    policy: never\n')
  const dir = await plugin(dataRoot, 'memory', { name: 'dsh-tavern-memory', exports: { '.': './index.mjs', './client': './client.js' }, dsh: { client: { platform: 'web' } } })
  await plugin(dataRoot, 'broken', null)
  await plugin(dataRoot, 'a-generic', { name: 'generic-lowercase', main: 'index.mjs' })
  await plugin(dataRoot, 'Z-generic', { name: 'generic-uppercase', main: 'index.mjs' })
  const warnings = []
  const result = await syncUserPlugins({ dataRoot, logger: { warn: text => warnings.push(text) } })
  assert.equal(result.changed, true)
  const text = await readFile(patch, 'utf8')
  assert.match(text, /# 我的覆盖/)
  assert.deepEqual(parse(text), [
    { id: 'approval', config: { policy: 'never' } },
    { insert: [
      { id: 'tavern-user-plugin-generic-uppercase', name: path.join(dataRoot, 'plugins/Z-generic', '.tavern-entry.mjs') },
      { id: 'tavern-user-plugin-generic-lowercase', name: path.join(dataRoot, 'plugins/a-generic', '.tavern-entry.mjs') },
      { id: 'tavern-user-plugin-dsh-tavern-memory', name: path.join(dir, '.tavern-entry.mjs') },
    ] },
  ])
  assert.match(warnings.join('\n'), /plugins\/broken：缺少 package\.json/)
  assert.equal((await syncUserPlugins({ dataRoot, logger: { warn() {} } })).changed, false, '没有变化时不改写文件')

  await rm(dir, { recursive: true })
  await rm(path.join(dataRoot, 'plugins', 'Z-generic'), { recursive: true })
  await rm(path.join(dataRoot, 'plugins', 'a-generic'), { recursive: true })
  await syncUserPlugins({ dataRoot, logger: { warn() {} } })
  assert.deepEqual(parse(await readFile(patch, 'utf8')), [{ id: 'approval', config: { policy: 'never' } }], '删掉文件夹后条目随之移除')
})

test('停用的插件文件夹还在，但不写进 patch；重新启用后恢复条目', async t => {
  const { dataRoot, profile } = await home(t)
  const patch = path.join(profile, 'cordis.patch.yml')
  const dir = await plugin(dataRoot, 'memory', { name: 'dsh-tavern-memory', main: 'index.mjs' })
  await plugin(dataRoot, 'broken', null)
  await syncUserPlugins({ dataRoot, logger: { warn() {} } })
  assert.deepEqual(parse(await readFile(patch, 'utf8')).at(-1).insert.map(entry => entry.id), ['tavern-user-plugin-dsh-tavern-memory'])

  await writeFile(path.join(dir, '.tavern-disabled'), '{}')
  // 停用的坏插件也不该再报警告。
  await writeFile(path.join(dataRoot, 'plugins', 'broken', '.tavern-disabled'), '{}')
  const warnings = []
  const stopped = await syncUserPlugins({ dataRoot, logger: { warn: text => warnings.push(text) } })
  assert.deepEqual(stopped.disabled.sort(), ['broken', 'memory'])
  assert.deepEqual(stopped.plugins, [])
  assert.deepEqual(stopped.problems, [])
  assert.deepEqual(warnings, [])
  assert.deepEqual(parse(await readFile(patch, 'utf8')), [], '停用后移除加载条目')
  assert.equal(JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')).name, 'dsh-tavern-memory', '插件文件保留')

  await rm(path.join(dir, '.tavern-disabled'))
  await syncUserPlugins({ dataRoot, logger: { warn() {} } })
  assert.deepEqual(parse(await readFile(patch, 'utf8')).at(-1).insert.map(entry => entry.id), ['tavern-user-plugin-dsh-tavern-memory'])
})

test('没有插件也没有旧条目时不碰 patch 文件；非 Tavern profile 时跳过', async t => {
  assert.equal(syncPatchText('[]', []), null)
  const { dataRoot, profile } = await home(t)
  await rm(path.join(profile, 'package.json'))
  await plugin(dataRoot, 'a', { name: 'a', main: 'index.mjs' })
  assert.equal((await syncUserPlugins({ dataRoot })).skipped, true)
})

test('缺少宿主入口的插件不登记', async t => {
  const { dataRoot } = await home(t)
  await plugin(dataRoot, 'ui-only', { name: 'ui-only', exports: { './client': './client.js' } }, { 'client.js': '' })
  await plugin(dataRoot, 'missing', { name: 'missing', main: 'nope.mjs' })
  const result = await syncUserPlugins({ dataRoot, logger: { warn() {} } })
  assert.deepEqual(result.plugins, [])
  assert.deepEqual(result.problems.map(problem => problem.folder).sort(), ['missing', 'ui-only'])
})

test('不折行改写用户的长路径；与已安装的包重名的插件不登记；同一原因只警告一次', async t => {
  const { dataRoot, profile } = await home(t)
  const long = '/very/long/' + 'path/'.repeat(30) + 'index.mjs'
  const patch = path.join(profile, 'cordis.patch.yml')
  await writeFile(patch, `- id: mine\n  name: "${long}"\n`)
  await mkdir(path.join(profile, 'node_modules', 'dsh-tavern-plugin'), { recursive: true })
  await writeFile(path.join(profile, 'node_modules', 'dsh-tavern-plugin', 'package.json'), '{}')
  await plugin(dataRoot, 'clash', { name: 'dsh-tavern-plugin', main: 'index.mjs' })
  await plugin(dataRoot, 'ok', { name: 'ok', main: 'index.mjs' })
  const warnings = []
  const logger = { warn: text => warnings.push(text) }
  await syncUserPlugins({ dataRoot, logger })
  await syncUserPlugins({ dataRoot, logger })
  const text = await readFile(patch, 'utf8')
  assert.ok(text.includes(`"${long}"`), '用户原有的长行保持一行')
  assert.deepEqual(parse(text).at(-1).insert.map(entry => entry.id), ['tavern-user-plugin-ok'])
  assert.equal(warnings.filter(text => text.includes('plugins/clash')).length, 1)
})

test('canonical profile 已登记时跳过 data/plugins 中旧名图片插件副本', async t => {
  const { dataRoot, profile } = await home(t)
  const installed = path.join(profile, 'node_modules', 'dsh-tavern-image')
  await mkdir(installed, { recursive: true })
  await writeFile(path.join(installed, 'package.json'), '{"name":"dsh-tavern-image"}')
  await plugin(dataRoot, 'dsh-tavern-comfy', { name: 'dsh-tavern-comfy', main: 'index.mjs' })
  const warnings = []

  const result = await syncUserPlugins({ dataRoot, logger: { warn: text => warnings.push(text) } })

  assert.deepEqual(result.plugins, [])
  assert.equal(result.problems.length, 1)
  assert.match(result.problems[0].reason, /已登记的图片插件身份（dsh-tavern-image）.*已跳过以避免重复加载；请在插件管理中检查重复登记/)
  assert.match(warnings.join('\n'), /plugins\/dsh-tavern-comfy/)
})

test('旧名 profile 已登记时跳过 data/plugins 中 canonical 图片插件副本', async t => {
  const { dataRoot, profile } = await home(t)
  const installed = path.join(profile, 'node_modules', 'dsh-tavern-comfy')
  await mkdir(installed, { recursive: true })
  await writeFile(path.join(installed, 'package.json'), '{"name":"dsh-tavern-comfy"}')
  await plugin(dataRoot, 'dsh-tavern-image', { name: 'dsh-tavern-image', main: 'index.mjs' })
  const warnings = []

  const result = await syncUserPlugins({ dataRoot, logger: { warn: text => warnings.push(text) } })

  assert.deepEqual(result.plugins, [])
  assert.equal(result.problems.length, 1)
  assert.match(result.problems[0].reason, /已登记的图片插件身份（dsh-tavern-comfy）.*已跳过以避免重复加载；请在插件管理中检查重复登记/)
  assert.match(warnings.join('\n'), /plugins\/dsh-tavern-image/)
})

test('两种图片插件 data/plugins 副本并存且 profile 未登记时只加载 canonical 包', async t => {
  const { dataRoot, profile } = await home(t)
  await plugin(dataRoot, 'dsh-tavern-comfy', { name: 'dsh-tavern-comfy', main: 'index.mjs' })
  const canonicalDir = await plugin(dataRoot, 'dsh-tavern-image', { name: 'dsh-tavern-image', main: 'index.mjs' })
  const warnings = []

  const result = await syncUserPlugins({ dataRoot, logger: { warn: text => warnings.push(text) } })
  const patch = parse(await readFile(path.join(profile, 'cordis.patch.yml'), 'utf8'))

  assert.equal(result.plugins.length, 1)
  assert.equal(result.plugins[0].folder, 'dsh-tavern-image')
  assert.equal(result.plugins[0].name, 'dsh-tavern-image')
  assert.equal(patch.at(-1).insert.length, 1)
  assert.equal(patch.at(-1).insert[0].name, path.join(canonicalDir, '.tavern-entry.mjs'))
  assert.match(warnings.join('\n'), /plugins\/dsh-tavern-comfy：同一生图插件存在多个副本，已保留一个并跳过重复项/)
})

test('插件经由 Tavern 的保护入口加载：导入失败或 apply 抛错只记日志，不让 DSH 起不来', async t => {
  const { dataRoot } = await home(t)
  const good = await plugin(dataRoot, 'good', { name: 'good-plugin', exports: { '.': './lib/main.mjs' } }, {})
  await mkdir(path.join(good, 'lib'))
  await writeFile(path.join(good, 'lib', 'main.mjs'), "export const name = 'good-plugin'\nexport const inject = ['tavern']\nexport function apply(ctx) { ctx.applied = true; return 'ok' }\n")
  const throwing = await plugin(dataRoot, 'throws', { name: 'throws', main: 'index.mjs' }, { 'index.mjs': "export async function apply() { throw new Error('启动炸了') }\n" })
  // 更新后宿主重启前会留下这个标记；成功加载才清掉，失败时保留给列表提示。
  await writeFile(path.join(good, '.tavern-restart.json'), '{}')
  await writeFile(path.join(throwing, '.tavern-restart.json'), '{}')
  await plugin(dataRoot, 'syntax', { name: 'syntax', main: 'index.mjs' }, { 'index.mjs': 'export function apply( {\n' })
  await plugin(dataRoot, 'default', { name: 'default', main: 'index.mjs' }, { 'index.mjs': 'export default function (ctx) { ctx.applied = true }\n' })
  const result = await syncUserPlugins({ dataRoot, logger: { warn() {} } })
  const load = async folder => import(pathToFileURL(result.plugins.find(item => item.folder === folder).entry).href + '?' + Math.random())
  const warnings = [], original = console.warn
  console.warn = text => warnings.push(String(text))
  t.after(() => { console.warn = original })
  const context = () => { const ctx = { plugin(value) { let result; try { result = Promise.resolve(value.apply(ctx)) } catch (error) { result = Promise.reject(error) }; return { await: () => result, dispose: async () => {} } } }; return ctx }
  const ok = await load('good'), ctx = context()
  assert.equal(ok.name, 'good-plugin')
  assert.deepEqual(ok.inject, ['tavern'])
  await ok.apply(ctx)
  assert.equal(ctx.applied, true)
  assert.equal(existsSync(path.join(good, '.tavern-restart.json')), false, '成功加载后清掉重启标记')
  const thrown = await load('throws')
  assert.equal(thrown.name, 'throws', '没有导出 name 时用包名')
  await thrown.apply(context())
  assert.equal(existsSync(path.join(throwing, '.tavern-restart.json')), true, '启动失败时保留重启标记')
  const broken = await load('syntax')
  assert.equal(await broken.apply(context()), undefined)
  const fallback = await load('default'), other = context()
  await fallback.apply(other)
  assert.equal(other.applied, true)
  assert.match(warnings.join('\n'), /plugins\/throws 启动失败：Error: 启动炸了/)
  assert.match(warnings.join('\n'), /plugins\/syntax 加载失败：SyntaxError/)
  assert.equal((await syncUserPlugins({ dataRoot, logger: { warn() {} } })).changed, false, '保护入口不变时不重写')
})


test('官方 Desktop：有 tavern 配置就写 tavern（桌面版切回原版时不把插件装进原版）；只有老式 desktop 安装才写 desktop', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-plugin-paths-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const data = path.join(root, 'profile-data/tavern/data')
  assert.deepEqual(userPluginPaths(data, root, 'desktop'), {plugins: path.join(data, 'plugins'), profile: path.join(root, 'profiles/desktop')})
  await mkdir(path.join(root, 'profiles/tavern'), { recursive: true })
  await writeFile(path.join(root, 'profiles/tavern/package.json'), '{}')
  assert.equal(userPluginPaths(data, root, 'desktop').profile, path.join(root, 'profiles/tavern'))
  assert.equal(userPluginPaths(data, root, 'cli').profile, path.join(root, 'profiles/tavern'))
})

test('桌面版回到原版 DSH 时，从原版配置里清掉旧版本写进去的酒馆插件条目', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-plugin-original-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dataRoot = path.join(root, 'profile-data/tavern/data')
  for (const name of ['tavern', 'desktop']) {
    await mkdir(path.join(root, 'profiles', name), { recursive: true })
    await writeFile(path.join(root, 'profiles', name, 'package.json'), '{}')
  }
  const original = path.join(root, 'profiles/desktop/cordis.patch.yml')
  await writeFile(original, '- insert:\n    - id: user-own\n      name: keep-me\n- insert:\n    - id: tavern-user-plugin-x\n      name: /x/.tavern-entry.mjs\n')
  const previous = process.env.DSH_TAVERN_RUNTIME_HOST
  process.env.DSH_TAVERN_RUNTIME_HOST = 'desktop'
  t.after(() => { if (previous === undefined) delete process.env.DSH_TAVERN_RUNTIME_HOST; else process.env.DSH_TAVERN_RUNTIME_HOST = previous })
  await syncUserPlugins({ dataRoot, logger: { warn() {} } })
  const text = await readFile(original, 'utf8')
  assert.doesNotMatch(text, /tavern-user-plugin-/)
  assert.match(text, /keep-me/, '用户自己的条目原样保留')
})

for (const pkg of [null, [], 'bad', {}, { name: 'broken' }, { name: 42, version: '1.0.0' }, { name: 'broken', version: 1 }, { name: 'broken', version: '  ' }]) {
  test('invalid manifest is removed from existing registration without rewriting plugin: ' + JSON.stringify(pkg), async t => {
    const { dataRoot, profile } = await home(t)
    const dir = await plugin(dataRoot, 'legacy', { name: 'legacy', version: '1.0.0', main: 'index.mjs' })
    await syncUserPlugins({ dataRoot, logger: { warn() {} } })
    const source = JSON.stringify(pkg)
    await writeFile(path.join(dir, 'package.json'), source)
    const result = await syncUserPlugins({ dataRoot, logger: { warn() {} } })
    assert.deepEqual(result.plugins, [])
    assert.equal(result.problems.length, 1)
    assert.match(result.problems[0].reason, /package.json/)
    assert.deepEqual(parse(await readFile(path.join(profile, 'cordis.patch.yml'), 'utf8')), [])
    assert.equal(await readFile(path.join(dir, 'package.json'), 'utf8'), source)
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'legacy', version: '1.0.0', main: 'index.mjs' }))
    assert.equal((await syncUserPlugins({ dataRoot, logger: { warn() {} } })).plugins.length, 1)
  })
}

test('invalid legacy registration removal preserves healthy plugins and manual patch entries', async t => {
  const { dataRoot, profile } = await home(t)
  const bad = await plugin(dataRoot, 'bad', { name: 'bad', main: 'index.mjs' })
  await plugin(dataRoot, 'healthy', { name: 'healthy', main: 'index.mjs' })
  const patch = path.join(profile, 'cordis.patch.yml')
  await writeFile(patch, '- insert:\n    - id: user-owned\n      name: /user/manual-plugin.mjs\n')
  await syncUserPlugins({ dataRoot, logger: { warn() {} } })
  await writeFile(path.join(bad, 'package.json'), '{"name":"bad","main":"index.mjs"}')
  await syncUserPlugins({ dataRoot, logger: { warn() {} } })
  assert.deepEqual(parse(await readFile(patch, 'utf8')).flatMap(op => op.insert || []).map(item => item.id), ['user-owned', 'tavern-user-plugin-healthy'])
})
