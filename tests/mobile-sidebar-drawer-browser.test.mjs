import test from 'node:test'
import assert from 'node:assert/strict'
import { html, nativeDrawer } from './fixtures/mobile-layout-browser.mjs'

test('手机原生抽屉：侧栏命中、遮罩关闭和重新展开', { skip: !process.env.TAVERN_BROWSER_TESTS, timeout: 60000 }, async t => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {})
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const settled = () => page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity))

  for (const width of [320, 390, 430, 720]) {
    await page.setViewportSize({ width, height: 844 })
    await page.setContent(html)
    await nativeDrawer(page)
    const drawer = page.locator('#drawer')
    await drawer.evaluate(el => el.classList.add('dsh-tavern-sidebar'))
    await page.getByRole('button', { name: '展开会话栏', exact: true }).tap()
    await settled()
    assert.notEqual(await drawer.evaluate(el => getComputedStyle(el).position), 'fixed', '酒馆侧栏跟随原生抽屉')
    for (const name of ['展开历史', '侧栏设置']) {
      const button = page.getByRole('button', { name, exact: true })
      const hit = await button.evaluate(el => {
        const r = el.getBoundingClientRect(), target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        return { inside: el.contains(target), mask: target?.hasAttribute('data-sidebar-mask') }
      })
      assert.equal(hit.inside, true, `${width}px ${name} 被遮罩截获: ${JSON.stringify(hit)}`)
      await button.tap()
      assert.equal(await page.locator('#drawer output').textContent(), name)
      assert.equal(await page.locator('#frame').getAttribute('data-sidebar-collapsed'), null)
    }
    // 从侧栏外的真实触点关闭，禁止强制点击绕过命中测试。
    await page.touchscreen.tap(width - 5, 400)
    await settled()
    assert.notEqual(await page.locator('#frame').getAttribute('data-sidebar-collapsed'), null)
    await page.getByRole('button', { name: '展开会话栏', exact: true }).tap()
    await page.getByRole('button', { name: '收起会话栏', exact: true }).tap()
    await settled()
    assert.equal(await page.locator('[class*="_sidebarCol"]').evaluate(el => getComputedStyle(el).visibility), 'hidden')
  }

  await t.test('没有原生抽屉或移动插件时保留旧宿主整屏兜底', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.setContent(html)
    await page.locator('#frame').evaluate(el => { el.removeAttribute('data-mobile-nav'); el.removeAttribute('data-sidebar-collapsed') })
    assert.equal(Math.round((await page.locator('[class*="_sidebarCol"]').boundingBox()).width), 390)
    await page.locator('#frame').evaluate(el => el.setAttribute('data-sidebar-collapsed', 'true'))
    assert.equal((await page.locator('[class*="_sidebarCol"]').boundingBox()).width, 0)
  })
  await t.test('移动插件与桌面布局继续由各自外壳管理', async () => {
    await page.setContent(html)
    await page.locator('#frame').evaluate(el => el.removeAttribute('data-sidebar-collapsed'))
    const sidebar = page.locator('[class*="_sidebarCol"]')
    assert.equal((await sidebar.boundingBox()).width, 56, '收起的酒馆侧栏保留移动插件窄条')
    await sidebar.locator('.dsh-tavern-sidebar').evaluate(el => el.classList.remove('collapsed'))
    assert.equal((await sidebar.boundingBox()).width, 390, '旧移动插件展开时使用上游整屏侧栏')
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.locator('#frame').evaluate(el => { el.removeAttribute('data-mobile-nav'); el.style.gridTemplateColumns = '240px minmax(0px,1fr) minmax(0px,0px)' })
    assert.equal((await sidebar.boundingBox()).width, 240, '桌面保留宿主列宽')
    assert.equal(await sidebar.evaluate(el => getComputedStyle(el).position), 'static')
  })
  assert.deepEqual(errors, [])
})
