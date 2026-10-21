import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const read = (file) => readFileSync(new URL('../tavern-plugin/src/client/modules/' + file, import.meta.url), 'utf8')

async function snapshotDom(html) {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM(`<body>${html}</body>`, { runScripts: 'outside-only' })
  dom.window.eval(read('frame-dom-snapshot.js') + ';window.capture=captureTavernBoundedDom')
  // 采集不得复制或整段序列化 DOM。
  for (const name of ['innerHTML', 'outerHTML'])
    Object.defineProperty(dom.window.Element.prototype, name, {
      get() {
        throw new Error('must not serialize DOM')
      },
    })
  dom.window.Node.prototype.cloneNode = () => {
    throw new Error('must not clone DOM')
  }
  return dom
}

test('预算内完整序列化：转义文本与属性、保留空元素、跳过宿主注入的脚本和样式', async () => {
  const dom = await snapshotDom(
    '<div title="a&quot;b"><img src="x.png" alt="图"><span>1 &lt; 2 &amp; 3</span></div><script data-dsh-tavern-frame>host()</script><style data-dsh-tavern-sizing>x{}</style><script>card()</script>',
  )
  try {
    const result = dom.window.capture(dom.window.document.body)
    assert.equal(
      result.dom,
      '<div title="a&quot;b"><img src="x.png" alt="图"><span>1 &lt; 2 &amp; 3</span></div><script>card()</script>',
    )
    assert.deepEqual([result.truncated, result.nodes, result.depth], [false, 6, 3])
  } finally {
    dom.window.close()
  }
})

test('节点数、深度与总字节预算先在遍历中裁剪，再序列化选中的节点', async () => {
  const dom = await snapshotDom(
    Array.from({ length: 10 }, (_, i) => `<p>${i}</p>`).join('') +
      '<section><div><div><b>深处</b></div></div></section>',
  )
  try {
    const { capture, document } = dom.window
    const byNodes = capture(document.body, { nodes: 6 })
    assert.equal(byNodes.dom, '<p>0</p><p>1</p><p>2</p><!-- 已截断 -->')
    assert.equal(byNodes.nodes, 6)
    const deep = capture(document.querySelector('section'), { depth: 2 })
    assert.equal(deep.dom, '<div><div></div></div><!-- 已截断 -->')
    assert.equal(deep.depth, 2)
    // 文本按剩余字节截断，且不把实体切成半截。
    document.body.textContent = '<<<<<<'
    const bytes = capture(document.body, { bytes: 10 })
    assert.equal(bytes.dom, '&lt;&lt;')
    assert.ok(bytes.bytes <= 10)
  } finally {
    dom.window.close()
  }
})

test('诊断登记处只向前台会话索取快照，注销后不再索取', async () => {
  const host = { __dshTavernSelectedSessionId: 's1' }
  const { createTavernFrameDiagnostics } = vm.runInNewContext(
    read('frame-diagnostics.js') + ';({ createTavernFrameDiagnostics })',
  )
  const diagnostics = createTavernFrameDiagnostics(host)
  const asked = []
  const entry = (session) => ({
    sessionId: () => session,
    snapshot: () => {
      asked.push(session)
      return Promise.resolve(true)
    },
  })
  const releaseA = diagnostics.register(entry('s1'))
  diagnostics.register(entry('s2'))
  diagnostics.register({ sessionId: () => 's1', snapshot: () => Promise.reject(new Error('frame gone')) })
  assert.equal(await diagnostics.capture('s1'), 1)
  assert.deepEqual(asked, ['s1'])
  assert.equal(await diagnostics.capture('s2'), 0, '后台会话不索取')
  assert.deepEqual(
    [diagnostics.foreground('s1'), diagnostics.foreground('s2'), diagnostics.foreground('')],
    [true, false, false],
  )
  releaseA()
  assert.equal(await diagnostics.capture('s1'), 0)
  assert.equal(diagnostics.size(), 2)
  // 尚未选中任何会话时，按调用方给出的会话处理。
  host.__dshTavernSelectedSessionId = ''
  assert.equal(await diagnostics.capture('s2'), 1)
})

test('超宽 DOM、超长文本和中文属性受真实访问与 UTF-8 字节上限约束', async () => {
  const dom = await snapshotDom('<div title="中文属性">中文🙂'.repeat(1) + '</div>')
  try {
    const { document, capture } = dom.window
    let value = capture(document.body, { bytes: 42 })
    assert.ok(Buffer.byteLength(value.dom, 'utf8') <= 42)
    assert.equal(value.bytes, Buffer.byteLength(value.dom, 'utf8'))
    document.body.firstChild.setAttribute('中文属性名', '值')
    value = capture(document.body, { bytes: 100 })
    assert.equal(value.bytes, Buffer.byteLength(value.dom, 'utf8'))
    document.body.textContent = '🙂<&'.repeat(100000)
    value = capture(document.body, { bytes: 31 })
    assert.ok(Buffer.byteLength(value.dom, 'utf8') <= 31)
    assert.equal(value.bytes, Buffer.byteLength(value.dom, 'utf8'))
    document.body.replaceChildren(...Array.from({ length: 10000 }, () => document.createElement('i')))
    let reads = 0
    const descriptor = Object.getOwnPropertyDescriptor(dom.window.Node.prototype, 'nextSibling')
    Object.defineProperty(dom.window.Node.prototype, 'nextSibling', {
      get() {
        reads++
        return descriptor.get.call(this)
      },
    })
    value = capture(document.body, { nodes: 10 })
    assert.ok(reads <= 10, `只允许访问预算内兄弟节点，实际 ${reads}`)
    assert.ok(value.visited <= 10)
    assert.equal(value.truncated, true)
  } finally {
    dom.window.close()
  }
})
