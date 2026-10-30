import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { chromium } from 'playwright'
import { browserReactScript } from './fixtures/browser-react.mjs'
import { readTavernRuntimeAsset } from '../tavern-plugin/lib/domain/tavern-runtime-assets.js'

const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')

test('无 MVU / Helper 的冷、热面板单击固定、返回正文及重复固定均保留页面状态', { timeout: 60000 }, async t => {
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {})
  t.after(() => browser.close())
  for (const eager of [false, true]) for (const panels of ['all', 'pinned']) {
    await t.test(`eager=${eager}, panels=${panels}`, async () => {
      const page = await browser.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      try {
        await page.route('http://tavern.test/**', async route => {
          const path = new URL(route.request().url()).pathname
          const asset = await readTavernRuntimeAsset(path)
          if (asset) return route.fulfill({ contentType: asset.mediaType, body: asset.body })
          if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<main id="root"></main>' })
          return route.fulfill({ status: 404, body: '' })
        })
        await page.goto('http://tavern.test/')
        await page.addScriptTag({ content: await browserReactScript() })
        await page.addScriptTag({ content: 'window.__ModuleLoader__={load(d){window.client=d.factory(name=>name==="react"?modules.react:{});}};' })
        await page.addScriptTag({ content: source })
        await page.evaluate(({ eager, panels }) => {
          if (typeof document.body.moveBefore !== 'function') throw new Error('Browser must support state-preserving moveBefore')
          // Keep the cold card truly cold until the click. Do not emulate moving
          // frames: every dock/restore below uses Chromium's real moveBefore.
          window.IntersectionObserver = class { observe() {} disconnect() {} }
          const React = modules.react, h = React.createElement
          const content = '<input id="answer" value="initial"><button id="count" onclick="window.count++">下一步</button><script>window.count=0;window.identity=Math.random();<\/script>'
          // A known height prevents idle premeasurement from warming the cold
          // frame before the tested first click.
          sessionStorage.setItem(['dsh-tavern-frame-height', 'no-helper', 1, 0, content.length].join(':'), '240')
          const view = { mode: 'story', tavernHelper: null, tavernMvuRuntime: null, tavernHelperScripts: [],
            // Automatic status views must remain gated; only manual docking is
            // enabled by this fix, not Helper/runtime creation for ordinary cards.
            tavernStatusViews: [{ viewId: 'auto', title: '自动状态', content: '<script>parent.automaticStatusStarted=true;<\/script>' }] }
          window.root = modules['react-dom/client'].createRoot(document.querySelector('#root'))
          root.render(h('div', null,
            h('article', { id: 'message' }, h(client.TavernMessageFrame, {
              sessionId: 'no-helper', turn: 1, partIndex: 0, content, eager, trustedCardMode: true, runtimeReporting: false
            })),
            h('aside', { id: 'sidebar' }, h(client.TavernPersistentStatusRuntime, { sessionId: 'no-helper', view, panels }))))
        }, { eager, panels })
        const pin = page.getByRole('button', { name: '固定到右侧', exact: true })
        await pin.waitFor()
        if (eager) await page.frameLocator('#message iframe').locator('#answer').waitFor()
        else assert.equal(await page.locator('#message iframe').count(), 0, 'cold click must precede mounting')
        await pin.click()
        const docked = page.frameLocator('#sidebar iframe')
        await docked.locator('#answer').waitFor({ timeout: 5000 })
        assert.equal(await pin.count(), 0, 'one click must finish pinning')
        assert.equal(await page.locator('#sidebar [data-status-view-id]').count(), 0)
        assert.equal(await page.evaluate(() => Boolean(window.automaticStatusStarted)), false)
        await docked.locator('#answer').fill('保留的输入')
        await docked.locator('#count').click()
        await page.evaluate(() => {
          window.savedFrame = document.querySelector('#sidebar iframe')
          window.savedDocument = savedFrame.contentDocument
          window.savedIdentity = savedFrame.contentWindow.identity
        })
        for (let round = 0; round < 2; round++) {
          await page.getByRole('button', { name: '返回正文栏', exact: true }).click()
          await page.frameLocator('#message iframe').locator('#answer').waitFor()
          assert.equal(await page.frameLocator('#message iframe').locator('#answer').inputValue(), '保留的输入')
          assert.deepEqual(await page.evaluate(() => ({
            sameFrame: document.querySelector('#message iframe') === savedFrame,
            sameDocument: savedFrame.contentDocument === savedDocument,
            sameIdentity: savedFrame.contentWindow.identity === savedIdentity,
            count: savedFrame.contentWindow.count
          })), { sameFrame: true, sameDocument: true, sameIdentity: true, count: 1 })
          if (round === 0) {
            await pin.click()
            await docked.locator('#answer').waitFor()
          }
        }
        assert.deepEqual(errors, [])
      } finally { await page.close() }
    })
  }
})
