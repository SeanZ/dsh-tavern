import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (file) => readFileSync(new URL('../tavern-plugin/src/client/' + file, import.meta.url), 'utf8')

test('一次高度采样内每个节点只读一次样式与几何，下一次采样重新读取', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM(
    '<body><div id="a" style="height:100vh"><p id="b">正文</p></div><section id="c" style="position:fixed;top:0;bottom:0"></section></body>',
    { runScripts: 'outside-only' },
  )
  try {
    const { window } = dom
    window.eval(`window.reads = new Map(); window.rects = new Map();
      const style = window.getComputedStyle; window.getComputedStyle = function (node) { reads.set(node.id, (reads.get(node.id) || 0) + 1); return style.apply(this, arguments) };
      const rect = Element.prototype.getBoundingClientRect; Element.prototype.getBoundingClientRect = function () { rects.set(this.id, (rects.get(this.id) || 0) + 1); return rect.apply(this, arguments) };`)
    window.eval(
      read('modules/frame-viewport-height.js') +
        ';window.createSample=createTavernLayoutSample;window.floor=tavernFrameViewportFloor',
    )
    const sample = window.createSample()
    assert.equal(window.floor(sample), 0)
    // 视口地板判断和后续可见区遍历读同一节点时复用本次采样的读数。
    for (const id of ['a', 'b', 'c']) {
      const node = window.document.getElementById(id)
      sample.style(node)
      sample.rect(node)
    }
    const counts = (map) => ['a', 'b', 'c'].map((id) => map.get(id))
    assert.deepEqual(counts(window.reads), [1, 1, 1])
    assert.deepEqual(counts(window.rects), [1, 1, 1])
    window.floor(window.createSample())
    assert.equal(window.reads.get('a'), 2, '新采样不沿用旧读数')
    // 不传采样时保持原有行为。
    assert.equal(window.floor(), 0)
  } finally {
    dom.window.close()
  }
})

async function viewportDom() {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM(
    '<body><div data-slot="conversation.header"><header></header></div><div data-composer-seat><div data-composer-card></div></div></body>',
    { runScripts: 'outside-only' },
  )
  const { window } = dom
  window.eval(`window.media = { narrow: true, touch: false }; window.rafQueue = [];
    window.matchMedia = query => { const key = /pointer/.test(query) ? 'touch' : 'narrow'; return { get matches() { return media[key] }, addEventListener() {}, removeEventListener() {} } };
    window.requestAnimationFrame = callback => rafQueue.push(callback); window.cancelAnimationFrame = () => {};
    window.flush = () => { const queued = rafQueue.splice(0); queued.forEach(callback => callback(0)) };
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: { height: 600, offsetTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} } });`)
  const frame = read('ui/message-frame.js')
  window.eval(
    frame.slice(0, frame.indexOf('// @include modules/mobile-layout.js')) +
      read('modules/mobile-layout.js') +
      ';window.pin=installVisualViewportPin',
  )
  return dom
}

test('视口 class 只在状态变化时写入；隐藏恢复和短视口边界保持', async () => {
  const dom = await viewportDom()
  try {
    const { window } = dom,
      html = window.document.documentElement
    const classes = new window.MutationObserver(() => {})
    classes.observe(html, { attributes: true, attributeFilter: ['class'] })
    const resync = () => {
      window.dispatchEvent(new window.Event('resize'))
      window.flush()
    }
    const release = window.pin(window.document)
    assert.deepEqual([...html.classList].sort(), ['dsh-tavern-coarse-play', 'dsh-tavern-viewport-pinned'])
    classes.takeRecords()
    for (let index = 0; index < 5; index++) resync()
    assert.equal(classes.takeRecords().length, 0, '状态不变不重写 class')
    // 可用高度恰为 280px 不算短视口，低于才算。
    window.visualViewport.height = 280
    resync()
    assert.equal(html.classList.contains('dsh-tavern-short-viewport'), false)
    window.visualViewport.height = 279
    resync()
    assert.equal(html.classList.contains('dsh-tavern-short-viewport'), true)
    assert.equal(classes.takeRecords().length, 1)
    assert.equal(html.style.getPropertyValue('--dsh-vv-height'), '279px')
    // 回到桌面：一次性移除并还原变量，之后的重算不再写入。
    window.media.narrow = false
    resync()
    assert.deepEqual([...html.classList], [])
    assert.equal(html.style.getPropertyValue('--dsh-vv-height'), '')
    classes.takeRecords()
    resync()
    resync()
    assert.equal(classes.takeRecords().length, 0)
    // 再回到窄屏：恢复钉住布局。
    window.media.narrow = true
    window.visualViewport.height = 600
    resync()
    assert.deepEqual([...html.classList].sort(), ['dsh-tavern-coarse-play', 'dsh-tavern-viewport-pinned'])
    release()
    assert.deepEqual([...html.classList], [])
    classes.disconnect()
  } finally {
    dom.window.close()
  }
})
