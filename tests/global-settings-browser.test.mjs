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

test('registered settings preserves model selection after rejected saves', async t => {
  const backend = fixture()
  const { page, calls } = await openTavernSettings(t, { respond: backend.respond })
  const model = page.getByLabel('默认前台模型', { exact: true })
  await page.waitForFunction(() => document.querySelector('[aria-label="默认前台模型"]')?.disabled === false)
  const choice = JSON.stringify({ provider: 'p', model: 'm' })
  await model.selectOption(choice)
  await page.getByText('已保存，下次新游戏生效', { exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('[aria-label="默认前台模型推理强度"]')?.disabled === false)
  await page.getByLabel('默认前台模型推理强度', { exact: true }).selectOption('low')
  await page.waitForFunction(() => document.querySelector('[aria-label="默认前台模型"]')?.disabled === false)
  assert.deepEqual(calls.filter(c => c.method === 'updateTavernSettings').at(-1).args.patch.defaultForegroundModel, { provider: 'p', model: 'm', reasoningEffort: 'low' })
  backend.setFail(true)
  await model.selectOption('')
  await page.getByRole('alert').filter({ hasText: '保存失败测试' }).waitFor()
  assert.equal(await model.inputValue(), choice)
  backend.setFail(false)
  await model.selectOption('')
  await page.waitForFunction(() => document.querySelector('[aria-label="默认前台模型"]')?.disabled === false)
  assert.equal(await model.inputValue(), '')
})

test('saving opening defaults preserves sibling values without reloading catalogs', async t => {
  const backend = fixture()
  const { page, calls } = await openTavernSettings(t, { respond: backend.respond })
  const toggle = page.getByRole('switch', { name: '联网搜索', exact: true })
  await page.waitForFunction(() => document.querySelector('[aria-label="联网搜索"]')?.disabled === false)
  const reads = Object.fromEntries(["getTavernSettings", "listPresets", "getUserPreferenceProfile"].map(method => [method, calls.filter(c => c.method === method).length]))
  // The controlled switch adopts its value only after the asynchronous save succeeds.
  await toggle.click()
  await page.getByText('已保存，新游戏继承此设置，已有游戏保持不变。', { exact: true }).waitFor()
  assert.equal(await toggle.isChecked(), true)
  assert.equal(await page.getByRole('switch', { name: '变量结算', exact: true }).isChecked(), true)
  for (const method of ['getTavernSettings', 'listPresets', 'getUserPreferenceProfile']) assert.equal(calls.filter(c => c.method === method).length, reads[method], method)
  backend.setFail(true)
  await toggle.click()
  await page.getByText('保存失败：保存失败测试', { exact: true }).waitFor()
  assert.equal(await toggle.isChecked(), true)
})

test('卡片工作台默认模型可单独保存，留空表示跟随前台', async t => {
  const backend = fixture()
  const { page, calls } = await openTavernSettings(t, { respond: backend.respond })
  const model = page.getByLabel('卡片工作台默认模型', { exact: true })
  await page.waitForFunction(() => document.querySelector('[aria-label="卡片工作台默认模型"]')?.disabled === false)
  assert.equal(await model.locator('option[value=""]').textContent(), '跟随前台')
  await model.selectOption(JSON.stringify({ provider: 'p', model: 'm' }))
  await page.getByText('已保存，下次新建工作台对话生效', { exact: true }).waitFor()
  assert.deepEqual(calls.filter(c => c.method === 'updateTavernSettings').at(-1).args.patch, { defaultWorkbenchModel: { provider: 'p', model: 'm' } })
})

test('联网资料保存源顺序与网页开关，测试显式触发，失败保留草稿', async t => {
  let config = { sources: ['bing', 'ddg'], searxngUrl: '', searxngEngines: [], proxyUrl: '', sourceProxies: {}, fetchEnabled: false }
  let fail = false
  const backend = fixture()
  const { page, calls } = await openTavernSettings(t, { respond(method, args) {
    if (method === 'getTavernSettings') return { ...backend.respond(method, args), settings: { ...backend.respond(method, args).settings, webAccess: config } }
    if (method === 'updateTavernSettings' && args.patch.webAccess) {
      if (fail) throw Error('模拟保存失败')
      config = args.patch.webAccess
      return { settings: { webAccess: config } }
    }
    if (method === 'testWebSearch') return { count: 2 }
    return backend.respond(method, args)
  } })
  await page.getByLabel('DuckDuckGo优先', { exact: true }).click()
  await page.getByRole('switch', { name: '允许读取网页正文', exact: true }).click()
  await page.getByText('SearXNG 配置', { exact: true }).click()
  await page.getByLabel('SearXNG 引擎', { exact: true }).fill('wikipedia,bing')
  await page.getByRole('button', { name: '保存搜索设置', exact: true }).click()
  await page.getByText('卡片工作台搜索设置已保存，后续调用生效。', { exact: true }).waitFor()
  assert.deepEqual(config.sources, ['ddg', 'bing'])
  assert.equal(config.fetchEnabled, true)
  assert.deepEqual(config.searxngEngines, ['wikipedia', 'bing'])
  assert.equal(calls.some(c => c.method === 'testWebSearch'), false)
  await page.getByRole('button', { name: '保存并测试搜索', exact: true }).click()
  await page.getByText('已保存，内置搜索测试成功，返回 2 条结果。', { exact: true }).waitFor()
  fail = true
  await page.getByLabel('SearXNG 实例地址', { exact: true }).fill('https://search.example')
  await page.getByRole('button', { name: '保存搜索设置', exact: true }).click()
  await page.getByText('模拟保存失败', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('SearXNG 实例地址', { exact: true }).inputValue(), 'https://search.example')
  assert.equal(config.searxngUrl, '')
})

test('自动生成候选项在「剧情」里，挨着上下文压缩，默认关闭；开关只保存自己，失败保留原值', async t => {
  const backend = fixture()
  const { page, calls } = await openTavernSettings(t, { respond: backend.respond })
  const group = page.getByRole('region', { name: '剧情', exact: true })
  const toggle = group.getByRole('switch', { name: '自动生成候选项', exact: true })
  await toggle.waitFor()
  assert.equal(await group.getByRole('heading', { name: '上下文压缩', exact: true }).count(), 1)
  assert.equal(await page.getByRole('region', { name: '显示与交互', exact: true }).getByRole('switch', { name: '自动生成候选项' }).count(), 0)
  assert.match(await group.locator('.dsh-tavern-settings-row').filter({ hasText: '自动生成候选项' }).innerText(), /每轮会多一次后台请求/)
  assert.equal(await toggle.isChecked(), false)
  await toggle.click()
  await group.getByText('已保存，所有游戏下一轮生效', { exact: true }).waitFor()
  assert.equal(await toggle.isChecked(), true)
  assert.deepEqual(calls.filter(c => c.method === 'updateTavernSettings').at(-1).args.patch, { candidateAutoGenerate: true })
  backend.setFail(true)
  await toggle.click()
  await group.getByText('保存失败：保存失败测试', { exact: true }).waitFor()
  assert.equal(await toggle.isChecked(), true)
})
test('手机宽度下默认模型各行不撑破卡片，第二个下拉留在卡片内', async t => {
  // 长模型名决定下拉的 min-content；短名字不会触发溢出，所以这里必须用长标识符。
  const settings = { defaultForegroundModel: null, defaultBackgroundModel: { provider: 'deepseek', model: 'deepseek-v4.1-flash-thinking-preview' },
    defaultWorkbenchModel: null, defaultPlaySettings: { playerName: '你', statusBarPlacement: 'sidebar', backgroundTasks: { variables: true, posture: true }, webSearchEnabled: false } }
  const { page } = await openTavernSettings(t, { respond(method) {
    if (method === 'getTavernSettings') return { settings, modelCatalog: [{ provider: 'deepseek', providerName: 'DeepSeek',
      models: [{ id: 'deepseek-v4.1-flash-thinking-preview', name: 'deepseek/deepseek-v4.1-flash-thinking-preview' }] }], releaseCapabilities: {} }
    if (method === 'getBackgroundModelReasoning') return { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }
    if (method === 'updateTavernSettings') return { settings }
  } })
  await page.waitForFunction(() => document.querySelector('[aria-label="默认前台模型"]')?.disabled === false)
  for (const width of [360, 390, 412, 430]) {
    await page.setViewportSize({ width, height: 1200 })
    const layout = await page.evaluate(() => {
      const right = document.querySelector('.dsh-tavern-gs-card').getBoundingClientRect().right
      return {
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
        rows: [...document.querySelectorAll('.dsh-tavern-model-row')].map(row => ({
          outside: [...row.querySelectorAll('select')].filter(select => select.getBoundingClientRect().right > right + 0.5).length,
          widths: [...row.querySelectorAll('select')].map(select => Math.round(select.getBoundingClientRect().width))
        }))
      }
    })
    assert.equal(layout.pageOverflow, false, `${width}: 设置页不产生横向滚动`)
    for (const [index, row] of layout.rows.entries()) {
      assert.equal(row.outside, 0, `${width}: 第 ${index + 1} 个模型行的下拉不越出卡片`)
      assert.ok(row.widths.every(value => value > 80), `${width}: 第 ${index + 1} 个模型行的下拉仍有可用宽度 ${row.widths}`)
    }
  }
})


test('侧栏显示开关即时保存，失败保留原值，焦点刷新读取已保存值', async t => {
  const backend = fixture()
  const { page, calls } = await openTavernSettings(t, { respond(method, args) {
    if (method === 'getDisplayPreferences') return backend.respond('getTavernSettings').settings
    return backend.respond(method, args)
  } })
  await page.getByText('侧栏显示', { exact: true }).click()
  const toggle = page.getByRole('switch', { name: '显示系统功能入口', exact: true })
  assert.equal(await toggle.isChecked(), false)
  await toggle.click()
  await page.waitForFunction(() => document.documentElement.classList.contains('dsh-tavern-show-system-navigation'))
  assert.deepEqual(calls.filter(c => c.method === 'updateTavernSettings').at(-1).args.patch, { showSystemNavigation: true })
  backend.setFail(true)
  await toggle.click()
  await page.getByText('保存失败：保存失败测试', { exact: true }).waitFor()
  assert.equal(await toggle.isChecked(), true)
  backend.setFail(false)
  backend.respond('updateTavernSettings', { patch: { showSystemNavigation: false } })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForFunction(() => !document.documentElement.classList.contains('dsh-tavern-show-system-navigation'))
  assert.equal(await toggle.isChecked(), false)
})
