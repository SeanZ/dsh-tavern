import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { nativeSettingsEntryId } from '../tavern-plugin/lib/native-settings.js'

test('设置所有者支持旧 Fiber 和 alpha.3 上下文身份，不能串到其它插件', () => {
  const fiber = {}, other = {}
  for (const current of [fiber, { ctx: { fiber } }]) {
    const ctx = { fiber, get: () => ({ entries: () => [
      { fiber: { ctx: { fiber: other } }, options: { id: 'other' } },
      { fiber: current, options: { id: 'owner' } }
    ] }) }
    assert.equal(nativeSettingsEntryId(ctx), 'owner')
  }
  assert.throws(() => nativeSettingsEntryId({ fiber, get: () => ({ entries: () => [] }) }), /not a profile entry/)
})

test('真实宿主门控接受素材库 alpha.3，无需版本豁免', { skip: !process.env.DSH_BOOT_MODULE }, async () => {
  const { evaluatePluginCompatibility } = await import(pathToFileURL(process.env.DSH_BOOT_MODULE))
  const manifest = JSON.parse(await readFile(new URL('../tavern-plugin/packages/dsh-asset-library/package.json', import.meta.url)))
  for (const version of ['0.2.2-alpha.2', '0.2.2-alpha.3']) assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined)
  assert.ok(evaluatePluginCompatibility(manifest, {}, '0.2.2-alpha.4'), '未验证的新版本不自动放行')
})

test('真实设置读写、通知、禁用及重载继续归属原插件', { skip: !process.env.DSH_BOOT_MODULE }, async t => {
  const { nativeSettingsProfile } = await import('./fixtures/native-settings-profile.mjs')
  const settingsUrl = new URL('../tavern-plugin/lib/mod-system-settings.js', import.meta.url).href
  const configUrl = new URL('../tavern-plugin/lib/settings-config.js', import.meta.url).href
  const h = await nativeSettingsProfile(t, { ownerSource: `export {Config} from ${JSON.stringify(configUrl)};
import {createManagedModSettingsOwner} from ${JSON.stringify(settingsUrl)};
export function apply(ctx){ctx.provide('identityFixture',createManagedModSettingsOwner(ctx));}` })
  const owner = h.ctx.get('identityFixture'), initial = owner.read()
  let notified = 0
  owner.subscribe(() => notified++)
  const value = structuredClone(initial.value)
  value.mods['example.fixture'] = true
  const saved = await owner.compareAndSwap({ expectedRevision: initial.revision, expectedValue: initial.value, value })
  assert.equal(saved.value.mods['example.fixture'], true)
  assert.ok(notified > 0)
  assert.deepEqual(h.value(h.ownerId, 'tavern-mod-system'), value)
  await h.disposeOwner()
  assert.throws(() => owner.read(), { code: 'MOD_DISABLED' })
  await h.setEnabled(h.ownerId, true)
  const reloaded = h.ctx.get('identityFixture')
  assert.notEqual(reloaded, owner)
  assert.deepEqual(reloaded.read().value, value)
  assert.deepEqual(h.errors, [])
})
