import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import test from 'node:test'

import { ensureSidebarDefaults, isServiceReady } from '../bin/dsh-tavern.mjs'

const windowsInstaller = await readFile(new URL('../install.ps1', import.meta.url), 'utf8')
const unixInstaller = await readFile(new URL('../install.sh', import.meta.url), 'utf8')

const installationSource = await readFile(new URL('../bin/profile-installation.mjs', import.meta.url), 'utf8')

const profilePatch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const managedProfilePatch = await readFile(new URL('../tavern-plugin/cordis.patch.yml', import.meta.url), 'utf8')

const rootManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

const tavernPluginManifest = JSON.parse(await readFile(new URL('../tavern-plugin/package.json', import.meta.url), 'utf8'))

test('Tavern sidebar migration marker与三个库设置写入 YAML', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-tavern-settings-'))
  t.after(async function () { await rm(directory, { recursive: true, force: true }) })
  const settingsPath = path.join(directory, 'settings.yaml')
  await writeFile(settingsPath, 'dsh-better-sidebar:\n  tabsEnabled:\n    editor: false\n', 'utf8')

  assert.equal(ensureSidebarDefaults(settingsPath), true)
  const written = await readFile(settingsPath, 'utf8')
  assert.match(written, /dsh-tavern:\n  sidebarDefaultsVersion: 8/)
  assert.match(written, /editor: true/)
  assert.match(written, /dsh-tavern:resources: true/)
  assert.match(written, /dsh-tavern:cards: true/)
  assert.match(written, /dsh-tavern:presets: true/)
  assert.doesNotMatch(written, /dsh-tavern:boundary-prompts/)
})

test('Web 服务就绪检查接受 alpha.2 鉴权响应', async () => {
  assert.equal(await isServiceReady(3081, async () => ({ ok: true })), true)
  assert.equal(await isServiceReady(3081, async () => ({ ok: false, status: 401 })), true)
  assert.equal(await isServiceReady(3081, async () => ({ ok: false })), false)
  assert.equal(await isServiceReady(3088, async () => ({ ok: false, status: 403 }), 'android'), true)
  assert.equal(await isServiceReady(3081, async () => ({ ok: false, status: 403 }), 'cli'), false)
  assert.equal(await isServiceReady(3088, async () => ({ ok: false, status: 500 }), 'android'), false)
  assert.equal(await isServiceReady(3081, async () => { throw new Error('offline') }), false)
})
