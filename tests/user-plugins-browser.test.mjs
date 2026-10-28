import assert from 'node:assert/strict'
import test from 'node:test'

import { openTavernSettings } from './fixtures/tavern-settings-browser.mjs'

test('酒馆插件页在安装前明确插件兼容范围', async t => {
  const { page } = await openTavernSettings(t, { section: 'dsh-tavern: plugins settings section' })
  const header = page.getByRole('region', { name: '酒馆插件', exact: true }).locator('header').first()
  await header.getByText('不支持 SillyTavern 插件，仅支持 DSH 插件和 DSH Tavern 插件。', { exact: true }).waitFor({ state: 'visible' })
  await header.getByText('给酒馆加功能：粘贴插件作者的 GitHub 地址即可安装。', { exact: true }).waitFor({ state: 'visible' })
})

// 设置 → 插件：已是最新时不显示更新按钮，有新版时按钮写明版本，停用/启用原地切换。
test('插件列表按 Release 显示更新、停用与启用', async t => {
  let plugins = [
    { folder: 'pet', name: 'dsh-tavern-desktop-pet', version: '0.2.2', description: '桌宠', source: { kind: 'github', repo: 'bigmalove/dsh-tavern-desktop-pet', resolved: 'Release v0.2.2' }, enabled: true, state: 'loaded', reason: '' },
    { folder: 'hub', name: 'dsh-runninghub', version: '1.1.4', description: 'RunningHub', source: { kind: 'github', repo: 'author/runninghub', resolved: 'Release v1.1.4' }, enabled: true, state: 'loaded', reason: '' },
    { folder: 'panel', name: 'dsh-tavern-worldbook-panel', version: '0.1.0', description: '世界书', source: { kind: 'folder' }, enabled: true, state: 'loaded', reason: '' },
  ]
  let updates = [
    { folder: 'pet', current: '0.2.2', latest: 'v0.2.2', status: 'latest' },
    { folder: 'hub', current: '1.1.4', latest: 'v1.1.5', status: 'available' },
  ]
  function respond(method, args) {
    if (method === 'listUserPlugins') return { plugins, dir: '/tmp/tavern/plugins' }
    if (method === 'checkUserPluginUpdates') return { plugins: updates }
    if (method === 'disableUserPlugin' || method === 'enableUserPlugin') {
      const enabled = method === 'enableUserPlugin'
      plugins = plugins.map(plugin => plugin.folder === args.folder ? { ...plugin, enabled, state: enabled ? 'pending' : 'disabled', reason: '' } : plugin)
      return { plugin: { folder: args.folder, enabled } }
    }
    if (method === 'updateUserPlugin') {
      plugins = plugins.map(plugin => plugin.folder === args.folder ? { ...plugin, version: '1.1.5', state: 'restart' } : plugin)
      updates = updates.map(update => update.folder === args.folder ? { ...update, current: '1.1.5', status: 'latest' } : update)
      return { plugin: { folder: args.folder, name: 'dsh-runninghub', version: '1.1.5', replaced: true } }
    }
  }
  const { page } = await openTavernSettings(t, { respond, section: 'dsh-tavern: plugins settings section' })
  const pet = page.locator('.dsh-tavern-user-plugin').filter({ hasText: 'dsh-tavern-desktop-pet' })
  const hub = page.locator('.dsh-tavern-user-plugin').filter({ hasText: 'dsh-runninghub' })
  const panel = page.locator('.dsh-tavern-user-plugin').filter({ hasText: 'dsh-tavern-worldbook-panel' })
  await pet.waitFor()

  await pet.locator('.dsh-tavern-user-plugin-copy .dsh-tavern-user-plugin-update.is-latest').waitFor()
  assert.equal(await pet.locator('.dsh-tavern-user-plugin-actions .dsh-tavern-user-plugin-update').count(), 0, '更新状态不放进按钮区')
  assert.equal(await pet.getByRole('button', { name: /更新/ }).count(), 0, '已是最新时不出现更新按钮')
  assert.equal(await panel.getByRole('button', { name: /更新/ }).count(), 0, '手动放入的插件没有更新按钮')

  await hub.getByRole('button', { name: '更新到 1.1.5', exact: true }).waitFor()
  await hub.getByRole('button', { name: '更新到 1.1.5', exact: true }).click()
  await page.getByText('已更新 dsh-runninghub 1.1.5，重启 DSH 后生效。', { exact: true }).waitFor()
  await hub.getByText('重启 DSH 后生效', { exact: true }).waitFor()
  await hub.getByText('已是最新', { exact: true }).waitFor()

  await pet.getByRole('button', { name: '停用', exact: true }).click()
  await pet.getByText('已停用', { exact: true }).waitFor()
  await pet.getByRole('button', { name: '启用', exact: true }).waitFor()
  await page.getByText('已停用 dsh-tavern-desktop-pet，刷新页面后生效。', { exact: true }).waitFor()

  await pet.getByRole('button', { name: '启用', exact: true }).click()
  await pet.getByRole('button', { name: '停用', exact: true }).waitFor()
  await pet.getByText('已停用', { exact: true }).waitFor({ state: 'detached' })
  await page.getByText('已启用 dsh-tavern-desktop-pet，刷新页面后生效。', { exact: true }).waitFor()
})

// 手动「检查更新」跳过自动检查的缓存，按钮旁边写明结果，徽标和更新按钮随之刷新。
test('插件列表可以手动检查更新', async t => {
  const plugins = [
    { folder: 'hub', name: 'dsh-runninghub', version: '1.1.4', description: 'RunningHub', source: { kind: 'github', repo: 'bigmalove/dsh-runninghub', resolved: 'Release v1.1.4' }, enabled: true, state: 'loaded', reason: '' },
    { folder: 'panel', name: 'dsh-tavern-worldbook-panel', version: '0.1.0', source: { kind: 'folder' }, enabled: true, state: 'loaded', reason: '' },
  ]
  let updates = [{ folder: 'hub', current: '1.1.4', latest: 'v1.1.4', status: 'latest' }]
  const calls = []
  function respond(method, args) {
    calls.push({ method, args })
    if (method === 'listUserPlugins') return { plugins, dir: '/tmp/tavern/plugins' }
    if (method === 'checkUserPluginUpdates') return { plugins: updates }
  }
  const { page } = await openTavernSettings(t, { respond, section: 'dsh-tavern: plugins settings section' })
  const hub = page.locator('.dsh-tavern-user-plugin').filter({ hasText: 'dsh-runninghub' })
  await hub.getByText('已是最新', { exact: true }).waitFor()

  const checks = () => calls.filter(call => call.method === 'checkUserPluginUpdates')
  assert.equal(checks().length, 1, '打开页面自动检查一次')
  assert.notEqual(checks()[0].args?.fresh, true, '自动检查走缓存')

  updates = [{ folder: 'hub', current: '1.1.4', latest: 'v1.1.5', status: 'available' }]
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await page.getByText('检查完成：有 1 个插件可以更新。', { exact: true }).waitFor()
  await hub.getByRole('button', { name: '更新到 1.1.5', exact: true }).waitFor()
  assert.equal(checks().length, 2)
  assert.equal(checks()[1].args?.fresh, true, '手动检查绕过缓存')

  updates = [{ folder: 'hub', current: '1.1.5', latest: 'v1.1.5', status: 'latest' }]
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await page.getByText('检查完成：没有发现新版本。', { exact: true }).waitFor()
  await hub.getByText('已是最新', { exact: true }).waitFor()
  assert.equal(await hub.getByRole('button', { name: /更新/ }).count(), 0)

  updates = [{ folder: 'hub', current: '1.1.5', status: 'error', reason: '连不上 GitHub' }]
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await page.getByRole('alert').getByText('检查完成：1 个插件检查失败。', { exact: true }).waitFor()
  assert.equal(checks().length, 4)
  assert.equal(checks()[3].args?.fresh, true)
})
