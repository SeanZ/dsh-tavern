import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (file) => readFileSync(new URL('../tavern-plugin/src/client/runtime/' + file, import.meta.url), 'utf8')
const artifacts = read('host-artifacts.js')
const scopeSource = artifacts.slice(
  artifacts.indexOf('function createTavernHostArtifactScope(options)'),
  artifacts.indexOf('const TAVERN_CARD_PHONE_HOST'),
)

async function hostDom() {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<body><main id="app"></main></body>', { runScripts: 'outside-only' })
  // 统计文档级观察器的创建与断开，验证空作用域不残留观察器。
  dom.window.eval(`window.observers = { live: 0, created: 0 };
    const Native = window.MutationObserver;
    window.MutationObserver = class extends Native {
      constructor(callback) { super(callback); window.observers.created++; this.live = false }
      observe(...args) { if (!this.live) { this.live = true; window.observers.live++ } return super.observe(...args) }
      disconnect() { if (this.live) { this.live = false; window.observers.live-- } return super.disconnect() }
    };
    window.cleaned = []; window.jQuery = { cleanData(nodes) { for (const node of nodes) window.cleaned.push(node.id || node.tagName) } };`)
  dom.window.eval(scopeSource + ';window.makeScope=createTavernHostArtifactScope')
  return dom
}

test('空的宿主产物作用域不挂文档 MutationObserver，登记节点后才观察', async () => {
  const dom = await hostDom()
  try {
    const { window } = dom
    const scope = window.makeScope({ document: window.document })
    scope.setVisible(false)
    scope.setVisible(true)
    assert.deepEqual({ ...window.observers }, { live: 0, created: 0 })
    scope.dispose()
    assert.deepEqual({ ...window.observers }, { live: 0, created: 0 })
    const tracked = window.makeScope({ document: window.document })
    tracked.trackNode(window.document.createElement('div'))
    assert.equal(window.observers.live, 1)
    tracked.dispose()
    assert.equal(window.observers.live, 0)
  } finally {
    dom.window.close()
  }
})

test('消息销毁只释放该消息渲染期间挂出的浮层与 jQuery 事件；并发渲染不归属任何消息', async () => {
  const dom = await hostDom()
  try {
    const { window } = dom,
      { document } = window,
      body = document.body
    const scope = window.makeScope({ document })
    const mount = (id) =>
      scope.mutateRoot(body, () =>
        body.insertAdjacentHTML('beforeend', `<div id="${id}"><button id="${id}-btn"></button></div>`),
      )
    const end3 = scope.beginMessage('3')
    mount('m3')
    end3()
    const end4 = scope.beginMessage('4')
    mount('m4')
    // 同一消息重入：计数归零前仍归属消息 4。
    const again4 = scope.beginMessage('4')
    end4()
    mount('m4b')
    again4()
    again4()
    const end5 = scope.beginMessage('5'),
      end6 = scope.beginMessage('6')
    mount('shared')
    end5()
    end6()
    mount('session')
    assert.equal(window.observers.live, 1)
    scope.releaseMessage('3')
    assert.equal(document.getElementById('m3'), null)
    assert.deepEqual(Array.from(window.cleaned), ['m3', 'm3-btn'])
    assert.ok(
      document.getElementById('m4') &&
        document.getElementById('m4b') &&
        document.getElementById('shared') &&
        document.getElementById('session'),
    )
    scope.releaseMessage('5')
    scope.releaseMessage('6')
    assert.ok(document.getElementById('shared'), '并发渲染期间的节点不能被任一消息释放')
    scope.releaseMessage('4')
    assert.equal(document.getElementById('m4'), null)
    assert.equal(document.getElementById('m4b'), null)
    // 隐藏后恢复不复活已释放的浮层。
    scope.setVisible(false)
    scope.setVisible(true)
    assert.equal(document.getElementById('m3'), null)
    assert.ok(document.getElementById('session'))
    scope.dispose()
    assert.equal(document.getElementById('session'), null)
    assert.equal(document.getElementById('shared'), null)
    assert.equal(window.observers.live, 0)
    assert.ok(document.getElementById('app'))
  } finally {
    dom.window.close()
  }
})

test('按消息释放后作用域已空则断开文档观察器', async () => {
  const dom = await hostDom()
  try {
    const { window } = dom,
      { document } = window,
      body = document.body
    const scope = window.makeScope({ document })
    const end = scope.beginMessage('7')
    const root = scope.trackNode(document.createElement('aside'))
    root.append(scope.trackNode(document.createElement('button')))
    scope.mutateRoot(body, () => body.append(root))
    end()
    assert.equal(window.observers.live, 1)
    scope.releaseMessage('7')
    assert.equal(window.observers.live, 0)
    assert.equal(document.querySelector('aside'), null)
    scope.dispose()
  } finally {
    dom.window.close()
  }
})

test('消息脚本层卸载时清理副本上的宿主 jQuery 事件并通知释放归属浮层', async () => {
  const dom = await hostDom()
  try {
    const { window } = dom,
      { document } = window
    window.eval(read('helper-host.js') + ';window.mountLayer=mountTavernScriptLayer')
    const native = document.createElement('div'),
      layer = document.createElement('div')
    native.innerHTML = '<p id="prose">正文</p>'
    document.body.append(native, layer)
    const released = []
    window.addEventListener('dsh-tavern-message-released', (event) => released.push(event.detail))
    const unmount = window.mountLayer({ native, layer, sessionId: 's1', messageId: 2 })
    assert.equal(layer.querySelector('#prose').textContent, '正文')
    unmount()
    assert.deepEqual(Array.from(window.cleaned), ['prose'])
    assert.deepEqual(
      released.map((value) => ({ ...value })),
      [{ sessionId: 's1', messageId: 2 }],
    )
    assert.equal(layer.childNodes.length, 0)
    assert.equal(native.hidden, false)
  } finally {
    dom.window.close()
  }
})

test('消息先卸载、异步渲染后完成时，迟到浮层仍被清理；随后重建不沿用旧归属', async () => {
  const dom = await hostDom()
  try {
    const { window } = dom,
      { document } = window
    const scope = window.makeScope({ document })
    const end = scope.beginMessage('8')
    scope.releaseMessage('8')
    scope.mutateRoot(document.body, () => document.body.append(document.createElement('aside')))
    end()
    assert.equal(document.querySelector('aside'), null)
    assert.equal(window.observers.live, 0)
    const next = scope.beginMessage('8')
    scope.mutateRoot(document.body, () => document.body.append(document.createElement('aside')))
    next()
    assert.ok(document.querySelector('aside'))
    scope.releaseMessage('8')
    assert.equal(document.querySelector('aside'), null)
    assert.equal(window.observers.live, 0)
    scope.dispose()
  } finally {
    dom.window.close()
  }
})
