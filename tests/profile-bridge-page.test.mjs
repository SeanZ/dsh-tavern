// 原版 DSH / DSH 酒馆切换页：两边各一个名字、一句说明、一个按钮。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { JSDOM } from 'jsdom'

const source = await readFile(new URL('../tavern-plugin/packages/dsh-profile-bridge/client.js', import.meta.url), 'utf8')

async function mount(status, calls = [], options = {}) {
  const inTavern = options.inTavern ?? (status.activeIsLink === true && status.linkTargetName === 'tavern')
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  // The Tavern client sets this flag on pages where it loaded.
  if (inTavern) dom.window.__dshTavernLoaded = true
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const React = (await import('react')).default
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const rpc = async (_channel, endpoint, payload) => {
    calls.push([endpoint, payload])
    if (options.rpc) return options.rpc(endpoint, payload)
    if (endpoint === 'shortcut') return { ok: true, value: { path: '/Users/me/Desktop/DSH 酒馆.app', existed: false } }
    return endpoint === 'status' ? { ok: true, value: status } : { ok: true, value: { closesApp: true } }
  }
  let module
  dom.window.__ModuleLoader__ = { load: ({ factory }) => { module = factory(name => name === 'react' ? React : undefined) } }
  new Function('window', source)(dom.window)
  let registered, page
  const dictionaries = {}
  const ctx = {
    locale: { bind: () => key => dictionaries.zh[key] ?? key, register: (_ns, value) => Object.assign(dictionaries, value) },
    connection: { rpc: { call: rpc } },
    effect: run => run(),
    slots: { inject: (_name, run) => run(), register: (meta, component) => { registered = meta; page = component; return () => {} } }
  }
  await act(async () => { module.apply(ctx) })
  const root = createRoot(dom.window.document.getElementById('root'))
  await act(async () => { root.render(React.createElement(page, registered.inject())) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return { dom, act, label: () => registered.label(), text: () => dom.window.document.body.textContent, button: () => dom.window.document.querySelector('.pb-bar .pb-btn'), calls, dispose: () => act(() => root.unmount()) }
}

const tavernProfile = { name: 'tavern', bundles: ['dsh-tavern-plugin', 'dsh-profile-bridge'], hasNodeModules: true }

test('在酒馆里叫「原版DSH」，按钮切回原版', async () => {
  const page = await mount({ appKind: 'desktop', activeIsLink: true, linkTargetName: 'tavern', backups: ['desktop.fresh-1'], profiles: [tavernProfile] })
  assert.equal(page.label(), '原版DSH')
  assert.match(page.text(), /同一个应用里的两套环境/)
  assert.equal(page.button().textContent, '重启并切换到原版 DSH')
  await page.act(async () => { page.button().click() })
  assert.deepEqual(page.calls.at(-1), ['unlink', {}])
  assert.match(page.text(), /正在重启/)
  page.dispose()
})

test('在原版 DSH 里叫「DSH酒馆」，按钮切到酒馆；没装好酒馆时说明原因', async () => {
  const page = await mount({ appKind: 'desktop', activeIsLink: false, backups: [], profiles: [tavernProfile] })
  assert.equal(page.label(), 'DSH酒馆')
  assert.equal(page.button().textContent, '重启并切换到 DSH 酒馆')
  await page.act(async () => { page.button().click() })
  assert.deepEqual(page.calls.at(-1), ['link', { target: 'tavern' }])
  page.dispose()

  const missing = await mount({ appKind: 'desktop', activeIsLink: false, backups: [], profiles: [] })
  assert.equal(missing.button(), null)
  assert.match(missing.text(), /还没有装好 DSH 酒馆/)
  missing.dispose()
})

test('原版备份丢了时不给按钮，并说明原因', async () => {
  const page = await mount({ appKind: 'desktop', activeIsLink: true, linkTargetName: 'tavern', backups: [], profiles: [tavernProfile] })
  assert.equal(page.button(), null)
  assert.match(page.text(), /找不到原版 DSH 的备份/)
  page.dispose()
})

test('「添加桌面快捷方式」只在点按钮时创建，并显示放在哪', async () => {
  const page = await mount({ appKind: 'desktop', activeIsLink: false, backups: [], profiles: [tavernProfile] })
  assert.ok(!page.calls.some(([endpoint]) => endpoint === 'shortcut'), '打开页面不自动创建')
  const button = [...page.dom.window.document.querySelectorAll('button')].find(item => item.textContent === '添加桌面快捷方式')
  assert.ok(button)
  await page.act(async () => { button.click() })
  assert.deepEqual(page.calls.at(-1), ['shortcut', {}])
  page.dispose()
})

test('快捷方式打开的独立酒馆窗口：不给切换按钮，只说明原版 DSH 直接打开', async () => {
  // 桌面版此时是原版（没有链接），这一页却是酒馆：以页面为准，不能给出「切到 DSH 酒馆」。
  const status = { appKind: 'desktop', desktopApp: false, activeIsLink: false, backups: [], profiles: [tavernProfile] }
  const page = await mount(status, [], { inTavern: true })
  assert.equal(page.label(), '原版DSH')
  assert.doesNotMatch(page.text(), /切到 DSH 酒馆/)
  assert.match(page.text(), /独立窗口/)
  const open = [...page.dom.window.document.querySelectorAll('button')].find(item => item.textContent === '打开原版 DSH')
  assert.ok(open, '给一个直接打开原版 DSH 的按钮')
  await page.act(async () => { open.click() })
  assert.deepEqual(page.calls.at(-1), ['openOriginal', {}])
  page.dispose()
})


test('重开页面后切换失败显示在折叠日志之外；文本不会解析成 HTML', async () => {
  const page = await mount({ appKind: 'desktop', profiles: [tavernProfile], lastResult: {
    status: 'failed', message: '<img src=x onerror=alert(1)> EBUSY desktop', logPath: 'C:\\dsh\\profile-bridge\\last-run.log',
  } })
  const alert = page.dom.window.document.querySelector('[role="alert"]')
  assert.ok(alert)
  assert.equal(alert.closest('details'), null)
  assert.match(alert.textContent, /上次切换失败.*EBUSY desktop/)
  assert.match(alert.textContent, /last-run.log/)
  assert.equal(alert.querySelector('img'), null)
  await page.act(async () => { page.button().click() })
  assert.equal(page.dom.window.document.querySelector('[role="alert"]'), null, 'accepted retry replaces previous failure with pending')
  page.dispose()
})

test('自动恢复失败时保留备份指引并阻止再次切换', async () => {
  const page = await mount({ appKind: 'desktop', profiles: [tavernProfile], lastResult: {
    status: 'failed', message: 'backup at desktop.fresh-1', recoveryRequired: true,
  } })
  assert.match(page.text(), /切换结果需要人工确认/)
  assert.equal(page.button().disabled, true)
  page.dispose()
})

test('成功结果不从历史日志误报失败', async () => {
  const page = await mount({ appKind: 'desktop', profiles: [tavernProfile], lastResult: { status: 'succeeded' }, logTail: 'ERROR: an earlier switch failed' })
  assert.equal(page.dom.window.document.querySelector('[role="alert"]'), null)
  assert.equal(page.button().disabled, false)
  page.dispose()
})

test('等待退出时禁用重复切换，超时结果不需要重新打开页面即可看到', async () => {
  let status = { appKind: 'desktop', profiles: [tavernProfile], lastResult: { status: 'pending', stamp: '1' } }
  const page = await mount(status, [], { rpc: async () => ({ ok: true, value: status }) })
  assert.equal(page.button().disabled, true)
  status = { ...status, lastResult: { status: 'failed', stamp: '1', message: '等待桌面退出超时' } }
  await page.act(async () => { await new Promise(resolve => setTimeout(resolve, 1600)) })
  assert.match(page.dom.window.document.querySelector('[role="alert"]').textContent, /等待桌面退出超时/)
  assert.equal(page.button().disabled, false)
  page.dispose()
})

test('重试请求被拒绝时不抹去原切换失败证据', async () => {
  const status = { appKind: 'desktop', profiles: [tavernProfile], lastResult: { status: 'failed', message: 'original failure' } }
  const page = await mount(status, [], { rpc: async endpoint => endpoint === 'status'
    ? { ok: true, value: status } : { ok: false, error: { message: 'busy' } } })
  await page.act(async () => { page.button().click() })
  assert.match(page.dom.window.document.querySelector('[role="alert"]').textContent, /original failure/)
  assert.match(page.text(), /busy/)
  assert.equal(page.button().disabled, false)
  page.dispose()
})

const managedStatus = {
  platform: 'win32', appKind: 'desktop', desktopApp: true, profiles: [tavernProfile],
  installation: { available: true, appDir: 'C:\\DSH\\apps\\dsh-tavern', profileDir: 'C:\\DSH\\profiles\\tavern', dataDir: 'C:\\DSH\\profile-data\\tavern', sharedHome: 'C:\\DSH' },
}
const namedButton = (page, text) => [...page.dom.window.document.querySelectorAll('button')].find(button => button.textContent === text)
async function enterDestination(page, value) {
  const input = page.dom.window.document.querySelector('#pb-destination')
  await page.act(async () => {
    Object.getOwnPropertyDescriptor(page.dom.window.HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new page.dom.window.Event('input', { bubbles: true }))
  })
}

test('安装管理显示程序、配置、完整酒馆数据和不迁移的共享路径；打开和取消不修改安装', async () => {
  const page = await mount(managedStatus)
  for (const value of Object.values(managedStatus.installation).filter(value => typeof value === 'string')) assert.ok(page.text().includes(value))
  assert.match(page.text(), /包括会话和存储/)
  assert.match(page.text(), /不保证立即释放旧磁盘空间/)
  await page.act(async () => namedButton(page, '切换安装目录').click())
  assert.ok(page.dom.window.document.querySelector('#pb-destination'))
  assert.equal(namedButton(page, '确认迁移并重启').disabled, true)
  await page.act(async () => namedButton(page, '取消').click())
  assert.equal(page.dom.window.document.querySelector('#pb-destination'), null)
  assert.deepEqual(page.calls.map(([endpoint]) => endpoint), ['status'])
  page.dispose()
})

test('卸载需要独立确认，保留数据和原版 DSH；重复点击只提交一次', async () => {
  let finish
  const calls = []
  const page = await mount(managedStatus, calls, { rpc: async endpoint => endpoint === 'status'
    ? { ok: true, value: managedStatus } : new Promise(resolve => { finish = resolve }) })
  await page.act(async () => namedButton(page, '删除 DSH 酒馆').click())
  assert.match(page.text(), /保留全部用户数据和备份，不卸载原版 DSH/)
  assert.deepEqual(calls.map(([endpoint]) => endpoint), ['status'])
  await page.act(async () => {
    namedButton(page, '确认删除并重启').click()
    namedButton(page, '确认删除并重启').click()
  })
  assert.deepEqual(calls.at(-1), ['uninstall', { confirmed: true }])
  assert.equal(calls.filter(([endpoint]) => endpoint === 'uninstall').length, 1)
  assert.equal(namedButton(page, '取消').disabled, true)
  await page.act(async () => finish({ ok: true, value: { closesApp: true } }))
  assert.match(page.text(), /操作已排队/)
  assert.equal(namedButton(page, '删除 DSH 酒馆').disabled, true)
  page.dispose()
})

test('不可管理、独立窗口、待处理及需要人工恢复的状态均禁止安装管理', async () => {
  for (const patch of [
    { installation: { ...managedStatus.installation, available: false, reason: 'unverified installation' } },
    { desktopApp: false },
    { lastResult: { status: 'pending' } },
    { lastResult: { status: 'failed', recoveryRequired: true, message: 'restore backup' } },
  ]) {
    const page = await mount({ ...managedStatus, ...patch })
    assert.equal(namedButton(page, '切换安装目录').disabled, true)
    assert.equal(namedButton(page, '删除 DSH 酒馆').disabled, true)
    page.dispose()
  }
})

test('迁移只接受绝对路径，显示失败后保留输入允许取消或重试', async () => {
  const page = await mount(managedStatus, [], { rpc: async endpoint => endpoint === 'status'
    ? { ok: true, value: managedStatus } : { ok: false, error: { message: '目标目录非空' } } })
  await page.act(async () => namedButton(page, '切换安装目录').click())
  await enterDestination(page, 'relative/path')
  assert.equal(namedButton(page, '确认迁移并重启').disabled, true)
  await enterDestination(page, 'D:\\DSH-Tavern')
  assert.equal(namedButton(page, '确认迁移并重启').disabled, false)
  await page.act(async () => namedButton(page, '确认迁移并重启').click())
  assert.deepEqual(page.calls.at(-1), ['relocate', { confirmed: true, destination: 'D:\\DSH-Tavern' }])
  assert.match(page.text(), /目标目录非空/)
  assert.equal(page.dom.window.document.querySelector('#pb-destination').value, 'D:\\DSH-Tavern')
  await page.act(async () => namedButton(page, '取消').click())
  assert.equal(page.dom.window.document.querySelector('#pb-destination'), null)
  page.dispose()
})
