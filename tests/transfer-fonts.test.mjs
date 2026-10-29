import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createTransferFonts } from '../tavern-plugin/lib/domain/transfer-fonts.js'
import { readZipEntries, writeZipEntries } from '../tavern-plugin/lib/domain/zip-entries.js'

const SANS_MANIFEST = JSON.stringify({
  id: 'note-sans', label: 'Note Sans', family: 'Note Sans', category: 'sans',
  files: [
    { weight: 400, style: 'normal', file: 'note-400.woff2', format: 'woff2' },
    { weight: 700, style: 'normal', file: 'note-700.woff2', format: 'woff2' }
  ]
})
const PLAIN_MANIFEST = JSON.stringify({ id: 'plain-face', label: '' })

async function writeTree(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, ...name.split('/'))
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'transfer-fonts-'))
  const fontsDir = path.join(root, 'fonts')
  const sans = {
    'index.json': SANS_MANIFEST,
    'note-400.woff2': Buffer.from('wOF2-400'),
    'note-700.woff2': Buffer.from('wOF2-700'),
    'OFL.txt': 'SIL Open Font License\n'
  }
  await writeTree(path.join(fontsDir, 'note-sans'), sans)
  const plain = { 'index.json': PLAIN_MANIFEST, 'plain.ttf': Buffer.from('ttf-bytes') }
  await writeTree(path.join(fontsDir, 'plain-face'), plain)
  // 没有 index.json 不是字体族；非法 id 不认；散落文件不算。
  await writeTree(path.join(fontsDir, 'unfinished'), { 'half.woff2': Buffer.from('x') })
  await writeTree(path.join(fontsDir, 'Bad_ID'), { 'index.json': JSON.stringify({ label: '坏 id' }) })
  await writeFile(path.join(fontsDir, 'stray.txt'), 'not a family')
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const transfer = createTransferFonts({ fontsDir })
  return { root, fontsDir, transfer, sans, plain }
}

function fontZip(entries) {
  return writeZipEntries(entries.map(([name, content]) => ({ path: name, content })))
}

test('list 只认含 index.json 的自装族，并统计标题、字重与字节', async t => {
  const { transfer, sans, plain } = await fixture(t)
  const rows = await transfer.list()

  assert.deepEqual(rows.map(row => row.key), ['note-sans', 'plain-face'])
  const note = rows[0]
  assert.equal(note.title, 'Note Sans')
  assert.equal(note.meta, '2 个字重')
  assert.equal(note.bytes, Buffer.byteLength(sans['index.json'])
    + Buffer.byteLength(sans['note-400.woff2'])
    + Buffer.byteLength(sans['note-700.woff2'])
    + Buffer.byteLength(sans['OFL.txt']))

  const bare = rows[1]
  assert.equal(bare.title, 'plain-face', '没有 label 时用 id')
  assert.equal(bare.meta, '字体', 'files 不是数组时退回“字体”')
  assert.equal(bare.bytes, Buffer.byteLength(plain['index.json']) + Buffer.byteLength(plain['plain.ttf']))
})

test('collect 把整族打成可读回的 zip，路径相对且统一用 /', async t => {
  const { transfer, sans } = await fixture(t)
  const items = await transfer.collect(['note-sans'])

  assert.equal(items.length, 1)
  const item = items[0]
  assert.equal(item.key, 'note-sans')
  assert.equal(item.title, 'Note Sans')
  assert.equal(item.fileName, 'note-sans.zip')
  assert.ok(Buffer.isBuffer(item.content))
  assert.equal(item.content.subarray(0, 2).toString('latin1'), 'PK')

  const entries = readZipEntries(item.content, { label: '字体包' })
  assert.deepEqual([...entries.keys()].sort(), ['OFL.txt', 'index.json', 'note-400.woff2', 'note-700.woff2'])
  assert.equal(entries.get('index.json').toString('utf8'), sans['index.json'])
  assert.equal(entries.get('OFL.txt').toString('utf8'), sans['OFL.txt'])
  assert.deepEqual(entries.get('note-400.woff2'), Buffer.from('wOF2-400'))
})

test('importOne 落成新目录，重名自动加后缀，不覆盖原族', async t => {
  const { transfer, fontsDir, sans } = await fixture(t)
  const zip = fontZip([
    ['index.json', JSON.stringify({ id: 'gamma-face', label: 'Gamma', files: [] })],
    ['gamma.ttf', 'ttf-gamma']
  ])

  const first = await transfer.importOne({ key: 'gamma-face', content: zip })
  assert.deepEqual(first, { id: 'gamma-face' })
  assert.deepEqual((await readdir(path.join(fontsDir, 'gamma-face'))).sort(), ['gamma.ttf', 'index.json'])
  assert.equal(await readFile(path.join(fontsDir, 'gamma-face', 'gamma.ttf'), 'utf8'), 'ttf-gamma')

  const second = await transfer.importOne({ key: 'gamma-face', content: fontZip([['index.json', '{}']]) })
  assert.deepEqual(second, { id: 'gamma-face-2' })

  const third = await transfer.importOne({ key: 'gamma-face', content: fontZip([['index.json', '{}']]) })
  assert.deepEqual(third, { id: 'gamma-face-3' })

  // 原族没被覆盖。
  assert.equal(await readFile(path.join(fontsDir, 'note-sans', 'note-400.woff2'), 'utf8'), sans['note-400.woff2'].toString())
  assert.equal(await readFile(path.join(fontsDir, 'note-sans', 'index.json'), 'utf8'), sans['index.json'])
})

test('importOne 拒绝越界路径，且不写 fonts 目录之外', async t => {
  const { transfer, fontsDir, root } = await fixture(t)

  await assert.rejects(() => transfer.importOne({ key: 'evil', content: fontZip([['../evil.txt', 'bad']]) }), /越界路径/)
  await assert.rejects(() => transfer.importOne({ key: 'evil', content: fontZip([['a/../../evil.txt', 'bad']]) }), /越界路径/)
  await assert.rejects(() => transfer.importOne({ key: 'evil', content: fontZip([['..\\..\\evil.txt', 'bad']]) }), /越界路径/)
  await assert.rejects(() => transfer.importOne({ key: 'evil', content: fontZip([['/etc/passwd', 'bad']]) }), /绝对路径/)

  assert.equal(existsSync(path.join(root, 'evil.txt')), false)
  assert.equal(existsSync(path.join(fontsDir, 'evil.txt')), false)
  assert.equal(existsSync(path.join(fontsDir, 'evil')), false)

  // 一条坏路径混在好路径里时，整个族都不落盘。
  await assert.rejects(() => transfer.importOne({
    key: 'mixed',
    content: fontZip([['index.json', '{}'], ['../evil.txt', 'bad']])
  }), /越界路径/)
  assert.equal(existsSync(path.join(fontsDir, 'mixed')), false)
})
