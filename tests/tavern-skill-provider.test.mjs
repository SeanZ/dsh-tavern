import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, realpath, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createTavernSkillModule } from '../tavern-plugin/lib/domain/tavern-skills.js'
import { createTavernSkillProvider } from '../tavern-plugin/lib/domain/tavern-skill-provider.js'

test('真实路径与目录别名下的写作 Skill 均可列出和读取，仍遵守用途、停用与来源限制', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-provider-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = path.join(root, 'skills')
  await mkdir(directory)
  const alias = path.join(root, 'alias')
  await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const library = createTavernSkillModule({ directory: alias, builtInDirectory: path.join(root, 'builtin') })
  await library.write({ name: 'writing-probe', purpose: 'writing', description: '写作', body: '写作正文' })
  const candidate = { name: 'writing-probe', path: await realpath(path.join(directory, 'writing-probe', 'SKILL.md')), description: '写作' }
  let role = 'foreground'
  let enabled = true
  const provider = createTavernSkillProvider({ library, roleFor: async () => role, enabledFor: async () => enabled,
    providers: [{ list: async () => [candidate], get: async value => ({ ...value, content: '宿主正文' }) }] })
  const lookup = { scope: {} }
  const listed = await provider.list(lookup)
  assert.deepEqual(listed.candidates.map(item => item.name), ['writing-probe'])
  assert.equal((await provider.get(listed.candidates[0], lookup)).content, '写作正文')
  role = 'background'
  assert.equal((await provider.list(lookup)).candidates.length, 0)
  role = 'foreground'
  enabled = false
  assert.equal(await provider.get(listed.candidates[0], lookup), undefined)
  enabled = true
  await library.assign('writing-probe', [])
  assert.equal((await provider.list(lookup)).candidates.length, 0)
  await library.assign('writing-probe', ['foreground'])
  const other = path.join(root, 'other.md')
  await writeFile(other, '同名但不是库里的文件')
  candidate.path = other
  assert.equal((await provider.list(lookup)).candidates.length, 0)
  candidate.path = path.join(root, 'missing.md')
  assert.equal((await provider.list(lookup)).candidates.length, 0)
})
