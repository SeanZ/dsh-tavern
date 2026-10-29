import test from 'node:test'
import assert from 'node:assert/strict'
import { openTavernSettings } from './fixtures/tavern-settings-browser.mjs'

function fixture() {
  let fail = false
  let settings = { defaultForegroundModel: null, defaultBackgroundModel: null,
    defaultPlaySettings: { playerName: '你', statusBarPlacement: 'sidebar', backgroundTasks: { variables: true, posture: true }, webSearchEnabled: false } }
  return {
    setFail(value) { fail = value },
    respond(method, args) {
      if (method === 'getTavernSettings') return { settings, modelCatalog: [{ provider: 'p', models: [{ id: 'm' }] }], releaseCapabilities: {} }
      if (method === 'getBackgroundModelReasoning') return { reasoning: { efforts: [{ id: 'low', name: 'Low' }] } }
      if (method === 'updateTavernSettings') {
        if (fail) throw Error('保存失败测试')
        const defaults = args.patch.defaultPlaySettings
        settings = { ...settings, ...args.patch, defaultPlaySettings: { ...settings.defaultPlaySettings, ...defaults,
          backgroundTasks: { ...settings.defaultPlaySettings.backgroundTasks, ...defaults?.backgroundTasks } } }
        return { settings }
      }
    }
  }
}

test('状态栏位置是全局显示偏好，保存后通知现有对局刷新', async t => {
  const backend = fixture()
  const { page, calls } = await openTavernSettings(t, { respond: backend.respond })
  const select = page.getByLabel('状态栏位置（所有对局）', { exact: true })
  await page.waitForFunction(() => Array.from(document.querySelectorAll('label')).some(row => row.textContent.includes('状态栏位置（所有对局）') && row.querySelector('select')?.disabled === false))
  await page.evaluate(() => { window.__statusSettingsChanged = 0; window.addEventListener('dsh-tavern-settings-changed', () => window.__statusSettingsChanged++); })
  await select.selectOption('body')
  await page.getByText('已保存，所有对局使用此状态栏位置。', { exact: true }).waitFor()
  assert.equal(await select.inputValue(), 'body')
  assert.deepEqual(calls.filter(call => call.method === 'updateTavernSettings').at(-1).args.patch, { defaultPlaySettings: { statusBarPlacement: 'body' } })
  assert.equal(await page.evaluate(() => window.__statusSettingsChanged), 1)
})

test('界面皮肤：导入后立即生效，选「默认」恢复原样', async t => {
  let index = { active: null, skins: [] }, css = ''
  const { page, calls } = await openTavernSettings(t, { section: 'dsh-tavern: interface skin settings', respond(method, args) {
    if (method === 'listInterfaceSkins') return index
    if (method === 'getActiveInterfaceSkin') return { id: index.active, css: index.active ? css : '' }
    if (method === 'importInterfaceSkin') { css = args.css; index = { active: 'aaaaaaaaaaaa', skins: [{ id: 'aaaaaaaaaaaa', name: args.name.replace(/\.css$/, '') }] }; return index }
    if (method === 'selectInterfaceSkin') { index = { ...index, active: args.id }; return index }
  } })
  const skinStyle = () => page.evaluate(() => document.querySelector('style[data-plugin-css="dsh-tavern-plugin/interface-skin"]')?.textContent ?? null)
  const select = page.getByLabel('皮肤', { exact: true })
  await page.waitForFunction(() => document.querySelector('select[aria-label="皮肤"]')?.disabled === false)
  await page.locator('input[type=file][accept^=".css"]').setInputFiles({ name: '纸感.css', mimeType: 'text/css', buffer: Buffer.from('body { color: rgb(1, 2, 3) }') })
  await page.getByText('已导入并启用', { exact: true }).waitFor()
  assert.deepEqual(calls.find(call => call.method === 'importInterfaceSkin').args, { name: '纸感.css', css: 'body { color: rgb(1, 2, 3) }' })
  assert.equal(await select.inputValue(), 'aaaaaaaaaaaa')
  await page.waitForFunction(() => getComputedStyle(document.body).color === 'rgb(1, 2, 3)')
  await select.selectOption('')
  await page.getByText('已切换', { exact: true }).waitFor()
  await page.waitForFunction(() => !document.querySelector('style[data-plugin-css="dsh-tavern-plugin/interface-skin"]'))
  assert.equal(await skinStyle(), null)
})
