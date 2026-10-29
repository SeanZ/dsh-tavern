import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createTransferPlugins } from '../tavern-plugin/lib/domain/transfer-plugins.js'
import { readZipEntries, writeZipEntries } from '../tavern-plugin/lib/domain/zip-entries.js'

const ALPHA_FILES = {
  'package.json': JSON.stringify({ name: 'alpha-plugin', version: '1.2.0' }) + '\n',
  'index.mjs': 'export default { name: \'alpha\' }\n',
  'node_modules/dep/index.js': 'module.exports = 1\n',
  // 版本库目录不进包，也不算进大小。
  '.git/config': '[core]\n\trepositoryformatversion = 0\n'
}
const BETA_FILES = { 'README.md': 'beta 插件\n' }

const PLUGINS = [
  { folder: 'alpha', name: 'Alpha 插件', version: '1.2.0', enabled: true },
  { folder: 'beta', name: '', version: '', enabled: false }
]

async function writeTree(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, ...name.split('/'))
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, text)
  }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'transfer-plugins-'))
  const pluginsDir = path.join(root, 'plugins')
  await writeTree(path.join(pluginsDir, 'alpha'), ALPHA_FILES)
  await writeTree(path.join(pluginsDir, 'beta'), BETA_FILES)
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const transfer = createTransferPlugins({ pluginsDir, listPlugins: async () => PLUGINS })
  return { root, pluginsDir, transfer }
}

function pluginZip(entries) {
  return writeZipEntries(entries.map(([name, text]) => ({ path: name, content: text })))
}

test('list 统计字节数与元信息：node_modules 算进包，.git 不算', async t => {
  const { transfer } = await fixture(t)
  const rows = await transfer.list()

  assert.deepEqual(rows.map(row => row.key), ['alpha', 'beta'])
  const alpha = rows[0]
  assert.equal(alpha.title, 'Alpha 插件')
  assert.equal(alpha.meta, '1.2.0 · 启用')
  assert.equal(alpha.bytes, Buffer.byteLength(ALPHA_FILES['package.json'])
    + Buffer.byteLength(ALPHA_FILES['index.mjs'])
    + Buffer.byteLength(ALPHA_FILES['node_modules/dep/index.js']))

  const beta = rows[1]
  assert.equal(beta.title, 'beta', '没有 name 时用文件夹名')
  assert.equal(beta.meta, '停用')
  assert.equal(beta.bytes, Buffer.byteLength(BETA_FILES['README.md']))
})

test('collect 产出可读回的 zip，路径相对插件文件夹且统一用 /', async t => {
  const { transfer } = await fixture(t)
  const items = await transfer.collect(['alpha'])

  assert.equal(items.length, 1)
  const item = items[0]
  assert.equal(item.key, 'alpha')
  assert.equal(item.title, 'Alpha 插件')
  assert.equal(item.fileName, 'alpha.zip')
  assert.ok(Buffer.isBuffer(item.content))
  assert.equal(item.content.subarray(0, 2).toString('latin1'), 'PK')

  const entries = readZipEntries(item.content, { label: '插件包' })
  assert.deepEqual([...entries.keys()].sort(), ['index.mjs', 'node_modules/dep/index.js', 'package.json'])
  assert.equal(entries.get('package.json').toString('utf8'), ALPHA_FILES['package.json'])
  assert.equal(entries.get('index.mjs').toString('utf8'), ALPHA_FILES['index.mjs'])
  assert.equal(entries.has('.git/config'), false, '.git 不进包')
})

test('collect 未知文件夹报错', async t => {
  const { transfer } = await fixture(t)
  await assert.rejects(() => transfer.collect(['nope']), /插件不存在：nope/)
})

test('importOne 解包到新文件夹，重名自动加序号，且不启用插件', async t => {
  const { transfer, pluginsDir } = await fixture(t)
  const zip = pluginZip([
    ['package.json', JSON.stringify({ name: 'gamma-plugin', version: '0.1.0' })],
    ['index.mjs', 'export default {}\n']
  ])

  const first = await transfer.importOne({ key: 'gamma', title: 'Gamma 插件', content: zip })
  assert.deepEqual(first, { folder: 'gamma' })
  assert.deepEqual((await readdir(path.join(pluginsDir, 'gamma'))).sort(), ['index.mjs', 'package.json'])
  assert.equal(await readFile(path.join(pluginsDir, 'gamma', 'index.mjs'), 'utf8'), 'export default {}\n')

  const second = await transfer.importOne({ key: 'alpha', title: 'Alpha 插件', content: zip })
  assert.equal(second.folder, 'alpha (2)')

  const third = await transfer.importOne({ key: 'alpha', title: 'Alpha 插件', content: pluginZip([['README.md', 'again']]) })
  assert.equal(third.folder, 'alpha (3)')

  // 原插件没有被覆盖，导入的插件也没有被启用。
  assert.equal(await readFile(path.join(pluginsDir, 'alpha', 'index.mjs'), 'utf8'), ALPHA_FILES['index.mjs'])
  assert.equal(existsSync(path.join(pluginsDir, 'alpha (2)', '.tavern-disabled')), false)
  assert.equal(existsSync(path.join(pluginsDir, 'alpha (2)', '.tavern-status.json')), false)
})

test('importOne 拒绝越界路径，且不写 plugins 目录之外', async t => {
  const { transfer, pluginsDir, root } = await fixture(t)

  await assert.rejects(() => transfer.importOne({ key: 'gamma', content: pluginZip([['../evil.txt', 'bad']]) }), /越界路径/)
  await assert.rejects(() => transfer.importOne({ key: 'gamma', content: pluginZip([['a/../../evil.txt', 'bad']]) }), /越界路径/)
  await assert.rejects(() => transfer.importOne({ key: 'gamma', content: pluginZip([['..\\..\\evil.txt', 'bad']]) }), /越界路径/)
  await assert.rejects(() => transfer.importOne({ key: 'gamma', content: pluginZip([['/etc/passwd', 'bad']]) }), /绝对路径/)

  assert.equal(existsSync(path.join(root, 'evil.txt')), false)
  assert.equal(existsSync(path.join(pluginsDir, 'evil.txt')), false)
  assert.equal(existsSync(path.join(pluginsDir, 'gamma')), false)
})

test('importOne 同一个包再来一次：复用已有目录，不再造 (2)', async t => {
  const { transfer, pluginsDir } = await fixture(t)
  const zip = pluginZip([
    ['package.json', JSON.stringify({ name: 'gamma-plugin', version: '0.1.0' })],
    ['index.mjs', 'export default {}\n']
  ])
  const first = await transfer.importOne({ key: 'gamma', title: 'Gamma 插件', content: zip })
  assert.deepEqual(first, { folder: 'gamma' })

  // 手机端重发、用户重试都算：内容一样就不再落一份副本。
  const again = await transfer.importOne({ key: 'gamma', title: 'Gamma 插件', content: zip })
  assert.deepEqual(again, { folder: 'gamma', reused: true })
  const names = await readdir(pluginsDir)
  assert.deepEqual(names.filter(name => name.startsWith('gamma')), ['gamma'])

  // 内容真的不一样，还是要新开一个目录，不能把已有的盖掉。
  const changed = await transfer.importOne({ key: 'gamma', title: 'Gamma 插件', content: pluginZip([['index.mjs', 'export default 2\n']]) })
  assert.equal(changed.folder, 'gamma (2)')
})
