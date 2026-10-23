import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

test(
  '真实浏览器默认诊断不克隆或序列化 DOM，显式快照遵守预算并立即回传',
  { skip: !process.env.TAVERN_BROWSER_TESTS },
  async (t) => {
    const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
    const browser = await chromium.launch({ headless: true })
    t.after(() => browser.close())
    const page = await browser.newPage()
    await page.setContent('<main></main>')
    await page.evaluate((source) => {
      window.__ModuleLoader__ = {
        load(d) {
          window.client = d.factory(() => ({}))
        },
      }
      window.eval(source)
      window.reports = []
      addEventListener('message', (e) => {
        if (e.data?.type === 'dsh-tavern-frame-runtime') reports.push(e.data)
      })
      const html = client.buildTavernFrameDocument({
        token: 'budget',
        content: '',
        helperContext: { messages: [] },
        runtimeReporting: true,
      })
      const reporter = html.match(/<script data-dsh-tavern-frame>([\s\S]*?)<\/script>/)[1]
      window.frame = document.createElement('iframe')
      const instrument = `window.serializations=0;Node.prototype.cloneNode=function(){serializations++;throw Error('clone forbidden')};for(const name of ['innerHTML','outerHTML'])Object.defineProperty(Element.prototype,name,{get(){serializations++;throw Error('serialize forbidden')}});`
      frame.srcdoc =
        '<body>' +
        Array.from({ length: 3000 }, (_, i) => `<p data-i="${i}">中文🙂 &lt;&amp;</p>`).join('') +
        '<script data-dsh-tavern-test>' +
        instrument +
        '</' +
        'script><script data-dsh-tavern-frame>' +
        reporter +
        '</' +
        'script>'
      document.querySelector('main').append(frame)
    }, source)
    await page.waitForFunction(() => reports.length > 0)
    assert.deepEqual(
      await page.evaluate(() => ({
        dom: reports.at(-1).runtime.dom,
        serializations: frame.contentWindow.serializations,
      })),
      { dom: '', serializations: 0 },
    )
    await page.evaluate(() =>
      frame.contentWindow.postMessage({ type: 'dsh-tavern-frame-dom-snapshot', token: 'budget' }, '*'),
    )
    await page.waitForFunction(() => reports.some((row) => row.explicit))
    const result = await page.evaluate(() => ({
      dom: reports.find((row) => row.explicit).runtime.dom,
      serializations: frame.contentWindow.serializations,
    }))
    assert.equal(result.serializations, 0)
    assert.ok(Buffer.byteLength(result.dom, 'utf8') <= 100000)
    assert.match(result.dom, /中文🙂 &lt;&amp;/)
    assert.doesNotMatch(result.dom, /data-i="1000"|data-dsh-tavern-test/)
    assert.match(result.dom, /已截断/)
  },
)
