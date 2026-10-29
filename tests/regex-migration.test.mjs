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
