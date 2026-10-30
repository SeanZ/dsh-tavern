import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createTransferSkills } from '../tavern-plugin/lib/domain/transfer-skills.js'
import { readZipEntries, writeZipEntries } from '../tavern-plugin/lib/domain/zip-entries.js'

const ALPHA_FILES = {
  'SKILL.md': '---\nname: alpha\ndescription: 场景写作\n---\n\n按需读 references/lesson.md\n',
  'references/lesson.md': '现成教学方法\n',
  // 版本库目录不算字节，也不进包。
  '.git/config': '[core]\n\trepositoryformatversion = 0\n'
}

const SKILLS = [
  { name: 'alpha', description: '场景写作', agents: ['foreground'], path: '' },
  { name: 'beta', description: '后台整理', agents: [], path: '' },
  { name: 'empty', description: '空目录', agents: ['foreground', 'background'], path: '' },
  { name: 'missing', description: '目录不存在', agents: [], path: '' }
]

async function writeTree(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, ...name.split('/'))
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, text)
  }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'transfer-skills-'))
  const skillsDir = path.join(root, 'skills')
  await writeTree(path.join(skillsDir, 'alpha'), ALPHA_FILES)
  await writeTree(path.join(skillsDir, 'beta'), { 'SKILL.md': '---\nname: beta\ndescription: 后台\n---\n\n正文\n' })
  await mkdir(path.join(skillsDir, 'empty'), { recursive: true })
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const transfer = createTransferSkills({ skillsDir, listSkills: async () => SKILLS })
  return { root, skillsDir, transfer }
}

function skillZip(entries) {
  return writeZipEntries(entries.map(([name, text]) => ({ path: name, content: text })))
}

test('list 统计 Skill 字节数、跳过空目录与不存在的目录，并区分用途', async t => {
  const { transfer } = await fixture(t)
  const rows = await transfer.list()

  assert.deepEqual(rows.map(row => row.key), ['alpha', 'beta'])
  const [alpha, beta] = rows
  assert.equal(alpha.title, 'alpha')
  assert.equal(alpha.meta, '写作 Skill · foreground')
  assert.equal(alpha.bytes, Buffer.byteLength(ALPHA_FILES['SKILL.md']) + Buffer.byteLength(ALPHA_FILES['references/lesson.md']))
  assert.equal(beta.meta, '写作 Skill')
  assert.equal(beta.bytes, Buffer.byteLength('---\nname: beta\ndescription: 后台\n---\n\n正文\n'))
})

test('collect 整目录打 zip：相对路径、统一 /、.git 不进包，可原样读回', async t => {
  const { transfer } = await fixture(t)
  const items = await transfer.collect(['alpha'])

  assert.equal(items.length, 1)
  const item = items[0]
  assert.equal(item.key, 'alpha')
  assert.equal(item.title, 'alpha')
  assert.equal(item.fileName, 'alpha.zip')
  assert.ok(Buffer.isBuffer(item.content))
  assert.equal(item.content.subarray(0, 2).toString('latin1'), 'PK')

  const entries = readZipEntries(item.content, { label: '写作 Skill 包' })
  assert.deepEqual([...entries.keys()].sort(), ['SKILL.md', 'references/lesson.md'])
  assert.equal(entries.get('SKILL.md').toString('utf8'), ALPHA_FILES['SKILL.md'])
  assert.equal(entries.get('references/lesson.md').toString('utf8'), ALPHA_FILES['references/lesson.md'])
})

test('importOne 解包到新目录，重名自动加序号且不覆盖已有 Skill', async t => {
  const { transfer, skillsDir } = await fixture(t)
  const zip = skillZip([
    ['SKILL.md', '---\nname: gamma\ndescription: 导入\n---\n\n正文\n'],
    ['references/ref.md', '引用\n']
  ])

  const first = await transfer.importOne({ key: 'gamma', content: zip })
  assert.deepEqual(first, { name: 'gamma' })
  assert.deepEqual((await readdir(path.join(skillsDir, 'gamma'))).sort(), ['SKILL.md', 'references'])
  assert.equal(await readFile(path.join(skillsDir, 'gamma', 'references', 'ref.md'), 'utf8'), '引用\n')

  const second = await transfer.importOne({ key: 'alpha', content: zip })
  assert.equal(second.name, 'alpha-2')
  const third = await transfer.importOne({ key: 'alpha', content: skillZip([['SKILL.md', 'again']]) })
  assert.equal(third.name, 'alpha-3')

  // 原 Skill 没有被覆盖。
  assert.equal(await readFile(path.join(skillsDir, 'alpha', 'SKILL.md'), 'utf8'), ALPHA_FILES['SKILL.md'])
  assert.deepEqual((await readdir(path.join(skillsDir, 'alpha'))).sort(), ['.git', 'SKILL.md', 'references'])
})

test('importOne 拒绝越界与非法路径，且不留下半个 Skill', async t => {
  const { transfer, skillsDir, root } = await fixture(t)

  await assert.rejects(() => transfer.importOne({ key: 'gamma', content: skillZip([['../evil.txt', 'bad']]) }), /越界路径/)
  await assert.rejects(() => transfer.importOne({ key: 'gamma', content: skillZip([['a/../../evil.txt', 'bad']]) }), /越界路径/)
  await assert.rejects(() => transfer.importOne({ key: 'gamma', content: skillZip([['..\\..\\evil.txt', 'bad']]) }), /越界路径/)
  await assert.rejects(() => transfer.importOne({ key: 'gamma', content: skillZip([['/etc/passwd', 'bad']]) }), /绝对路径/)
  await assert.rejects(() => transfer.importOne({ key: 'gamma', content: skillZip([['SKILL.md', 'ok'], ['../evil.txt', 'bad']]) }), /越界路径/)

  assert.equal(existsSync(path.join(root, 'evil.txt')), false)
  assert.equal(existsSync(path.join(skillsDir, 'evil.txt')), false)
  assert.equal(existsSync(path.join(skillsDir, 'gamma')), false)
})
