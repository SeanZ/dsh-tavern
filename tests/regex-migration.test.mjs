import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createProfileDataStore } from '../tavern-plugin/lib/profile-data-store.js'
import { createTavernExtensionSettings } from '../tavern-plugin/lib/domain/tavern-extension-settings.js'
import { createTavernRegexSettings } from '../tavern-plugin/lib/domain/regex-settings.js'
import { createRegexLibrary } from '../tavern-plugin/lib/domain/regex-library.js'
import { createRegexManager } from '../tavern-plugin/lib/domain/regex-manager.js'
import { createRegexHandlers } from '../tavern-plugin/lib/rpc/regex.js'

const LEGACY = {
  version: 1,
  items: [
    {
      id: 'legacy-test-narration', name: '旧库：旁白转引用',
      script: { id: 'legacy-script-narration', scriptName: '旧库：旁白转引用', findRegex: '/^【旁白】(.*)$/gm', replaceString: '> $1', placement: [2], disabled: false, markdownOnly: true }
    },
    {
      id: 'legacy-test-tag', name: '旧库：删除旧标记',
      script: { id: 'legacy-script-tag', scriptName: '旧库：删除旧标记', findRegex: '/【旧库标记】/g', replaceString: '', placement: [2], disabled: false }
    }
  ]
}

const EXISTING = { id: 'existing-global', scriptName: '已有全局规则', findRegex: '/existing/g', replaceString: 'E', trimStrings: [], placement: [2], disabled: false, extraField: 'keep-me' }

function services(root) {
  const profileData = createProfileDataStore({ dataRoot: root })
  const extensionSettings = createTavernExtensionSettings(profileData)
  const regexSettings = createTavernRegexSettings({ extensionSettings })
  const regexLibrary = createRegexLibrary({ store: profileData })
  const manager = createRegexManager({
    regexSettings,
    legacyLibrary: regexLibrary,
    chatForSession: async () => undefined,
    groupOfMode: () => 'play',
    readCardSources: async () => ({ regexScripts: [] }),
    updateChat: async () => undefined
  })
  return { profileData, extensionSettings, regexSettings, regexLibrary, manager }
}

async function workspace(t, settings = { EjsTemplate: { enabled: true }, regex: [EXISTING] }, legacy = LEGACY) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tavern-regex-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, 'tavern-extension-settings.json'), JSON.stringify(settings, null, 2))
  if (legacy !== null) await writeFile(path.join(root, 'regex-library.json'), JSON.stringify(legacy, null, 2))
  return root
}

test('real profile files: migrates legacy items once, keeps existing global rules and the old file', async t => {
  const root = await workspace(t)
  const first = await services(root)
  const data = await first.manager.read('')
  assert.equal(data.migrated, 2)
  assert.deepEqual(data.global.map(entry => [entry.name, entry.enabled]), [
    ['已有全局规则', true],
    ['旧库：旁白转引用', false],
    ['旧库：删除旧标记', false]
  ])
  assert.equal(data.global[0].key, 'existing-global')

  const settings = JSON.parse(await readFile(path.join(root, 'tavern-extension-settings.json'), 'utf8'))
  assert.deepEqual(settings.EjsTemplate, { enabled: true })
  assert.equal(settings.regex.length, 3)
  assert.equal(settings.regex[1].id, 'legacy-script-narration')
  assert.equal(settings.regex[1].scriptName, '旧库：旁白转引用')
  assert.equal(settings.regex[1].disabled, true)
  assert.equal(settings.regex[0].extraField, 'keep-me')

  const legacy = JSON.parse(await readFile(path.join(root, 'regex-library.json'), 'utf8'))
  assert.equal(legacy.items.length, 2)
  assert.equal(legacy.items[0].script.findRegex, '/^【旁白】(.*)$/gm')
  assert.equal(legacy.migratedTo, 'global')
  assert.equal(typeof legacy.migratedAt, 'number')

  // A new process (new stores over the same directory) must not migrate again.
  const restarted = await services(root)
  const second = await restarted.manager.read('')
  assert.equal(second.migrated, 0)
  assert.deepEqual(second.global.map(entry => entry.name), ['已有全局规则', '旧库：旁白转引用', '旧库：删除旧标记'])
})

test('RPC read reports the migration count and the disabled legacy rules', async t => {
  const root = await workspace(t)
  const { manager } = services(root)
  const handlers = createRegexHandlers({ regexManager: manager, str: value => value === undefined || value === null ? '' : String(value) })
  const data = await handlers.getRegexManager({})
  assert.equal(data.migrated, 2)
  assert.equal(data.preset, null)
  assert.equal(data.card, null)
  assert.deepEqual(data.global.map(entry => [entry.name, entry.enabled]), [
    ['已有全局规则', true],
    ['旧库：旁白转引用', false],
    ['旧库：删除旧标记', false]
  ])
})

test('two concurrent first reads never duplicate the migrated rules', async t => {
  const root = await workspace(t, { EjsTemplate: { enabled: true }, regex: [] })
  const a = services(root)
  const b = services(root)
  const results = await Promise.all([a.manager.read(''), b.manager.read('')])
  assert.equal(results.reduce((total, item) => total + item.migrated, 0), 2)
  const settings = JSON.parse(await readFile(path.join(root, 'tavern-extension-settings.json'), 'utf8'))
  assert.deepEqual(settings.regex.map(script => script.id), ['legacy-script-narration', 'legacy-script-tag'])
  const legacy = JSON.parse(await readFile(path.join(root, 'regex-library.json'), 'utf8'))
  assert.equal(legacy.migratedTo, 'global')
})

test('an invalid legacy row is skipped and still marked, without breaking valid rows', async t => {
  const legacy = {
    version: 1,
    items: [
      { id: 'bad', name: '坏条目', script: { findRegex: '' } },
      { id: 'good', name: '好条目', script: { id: 'good-script', findRegex: '/good/g', replaceString: '' } }
    ]
  }
  const root = await workspace(t, { EjsTemplate: { enabled: true }, regex: [] }, legacy)
  const { manager } = services(root)
  const data = await manager.read('')
  assert.equal(data.migrated, 1)
  assert.deepEqual(data.global.map(entry => entry.name), ['好条目'])
  const saved = JSON.parse(await readFile(path.join(root, 'regex-library.json'), 'utf8'))
  assert.equal(saved.migratedTo, 'global')
})

test('a missing legacy file leaves settings untouched', async t => {
  const root = await workspace(t, { EjsTemplate: { enabled: true }, regex: [EXISTING] }, null)
  const { manager } = services(root)
  const data = await manager.read('')
  assert.equal(data.migrated, 0)
  const settings = JSON.parse(await readFile(path.join(root, 'tavern-extension-settings.json'), 'utf8'))
  assert.deepEqual(settings.regex, [EXISTING])
  await assert.rejects(readFile(path.join(root, 'regex-library.json'), 'utf8'), /ENOENT/)
})
