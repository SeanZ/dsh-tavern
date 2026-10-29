import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'
import { pathToFileURL } from 'node:url'
import { syncUserPlugins } from '../tavern-plugin/lib/domain/user-plugins.js'

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

test('缺少宿主入口的插件不登记', async t => {
  const { dataRoot } = await home(t)
  await plugin(dataRoot, 'ui-only', { name: 'ui-only', exports: { './client': './client.js' } }, { 'client.js': '' })
  await plugin(dataRoot, 'missing', { name: 'missing', main: 'nope.mjs' })
  const result = await syncUserPlugins({ dataRoot, logger: { warn() {} } })
  assert.deepEqual(result.plugins, [])
  assert.deepEqual(result.problems.map(problem => problem.folder).sort(), ['missing', 'ui-only'])
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
