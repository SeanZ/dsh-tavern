import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../tavern-plugin/packages/dsh-tavern-image-bundled/client.js', import.meta.url), 'utf8')
const from = source.indexOf('\n      function worldbookTab() {')
const until = source.indexOf('\n      function galleryTab()', from)
assert.ok(from >= 0 && until > from)
const component = source.slice(from, until)
const clone = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function walk(node, predicate, result = []) {
  if (Array.isArray(node)) { node.forEach(child => walk(child, predicate, result)); return result }
  if (!node || typeof node !== 'object') return result
  if (predicate(node)) result.push(node)
  node.children?.forEach(child => walk(child, predicate, result))
  return result
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('')
  if (node == null || typeof node === 'boolean') return ''
  return typeof node === 'object' ? text(node.children || []) : String(node)
}
function one(tree, predicate, name) { const result = walk(tree, predicate); assert.equal(result.length, 1, name); return result[0] }
function harness() {
  const books = format => ['main', 'outfits'].map(key => ({ key, name: `${format}-${key}`, entries: [
    { index: 0, comment: `${format}-${key}-rule`, content: `original ${format} ${key}`, enabled: true, activation: 'always', backends: [] },
  ] }))
  const server = Object.fromEntries(['tags', 'natural', 'mixed', 'structured'].map(format => [format, books(format)]))
  const state = { data: { worldbookFormat: 'tags', worldbookBooks: clone(server.tags), config: { promptMode: 'tags' } },
    wbFormat: 'tags', wbView: null, wbLoading: false, wbBook: 'main', wbEditing: -1, wbOpen: {}, wbImportOpen: false, wbPaste: '', wbNote: '', wbDrafts: {} }
  const refs = { wbTransition: { current: false }, wbReadEpoch: { current: 0 }, wbScope: { current: '' }, wbFlushing: { current: null }, wbActions: { current: new Set() },
    wbTimer: { current: null }, wbPending: { current: {} }, wbWriteQueue: { current: Promise.resolve() }, wbDraftRevisions: { current: {} } }
  const calls = [], timers = new Map(), clipboard = []
  let nextTimer = 0, failWrites = false, writeGate = null, readGate = null, wrongFormat = false
  const setters = Object.fromEntries(Object.keys(state).map(key => [`set${key[0].toUpperCase()}${key.slice(1)}`, value => { state[key] = typeof value === 'function' ? value(state[key]) : value }]))
  async function transport(url, init = {}) {
    const parsed = new URL(url, 'http://fixture'), path = parsed.pathname.replace('/plugins/dsh-tavern-image', '')
    const method = init.method || 'GET', body = init.body ? JSON.parse(init.body) : null
    calls.push({ path, query: Object.fromEntries(parsed.searchParams), method, body })
    const format = body?.format || parsed.searchParams.get('format')
    assert.ok(Object.hasOwn(server, format), `every worldbook request specifies format: ${url}`)
    if (method === 'POST') {
      if (writeGate) await writeGate.promise
      if (failWrites) throw new Error('fixture save rejected')
      const book = server[format].find(item => item.key === body.book)
      assert.ok(book)
      if (path === '/worldbook-entry') {
        if (body.remove) book.entries.splice(body.index, 1)
        else Object.assign(book.entries[body.index], body.patch)
        return { ok: true }
      }
      if (path === '/worldbook-add') { book.entries.push({ index: book.entries.length, comment: body.comment, content: body.content }); return { ok: true, index: book.entries.length - 1 } }
      if (path === '/worldbook-import') { book.entries = [{ index: 0, comment: 'imported', content: String(body.worldbook) }]; return { ok: true, name: 'imported', count: 1 } }
      assert.fail('unexpected write ' + path)
    }
    if (path === '/worldbook-export') return { ok: true, worldbook: { entries: clone(server[format].find(book => book.key === parsed.searchParams.get('book')).entries) } }
    assert.equal(path, '/worldbook')
    const snapshot = { ok: true, worldbookFormat: wrongFormat ? 'wrong' : format, worldbook: { name: format, entries: clone(server[format].flatMap(book => book.entries)) }, worldbookBooks: clone(server[format]) }
    const gate = readGate
    readGate = null
    if (gate) await gate.promise
    return snapshot
  }
  const context = vm.createContext({ ...refs, ...setters, WorldbookUpgradePanel: () => null, promptFormatFocus: { current: false }, setTab: value => { state.tab = value }, BASE: '/plugins/dsh-tavern-image', jsonFetch: transport,
    post: (path, body) => transport('/plugins/dsh-tavern-image' + path, { method: 'POST', body: JSON.stringify(body) }),
    h: (type, props, ...children) => ({ type, props: props || {}, children }), S: { card: {}, row: {}, input: {}, label: {}, tab: () => ({}) }, buttonStyle: {},
    setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id }, clearTimeout: id => timers.delete(id), confirm: () => true,
    navigator: { clipboard: { writeText: async value => clipboard.push(value) } },
  })
  const renderFn = vm.runInContext(`(snapshot => { const {${Object.keys(state).join(',')}} = snapshot; const config=data.config; ${component}; return worldbookTab() })`, context)
  let tree
  const render = () => { tree = renderFn(state); return tree }
  const button = label => one(tree, node => node.type === 'button' && text(node) === label, 'button ' + label)
  const formatSelect = () => one(tree, node => node.props['aria-label'] === '世界书格式', 'format select')
  async function settle(action) { await action(); await tick(); await Promise.all([...refs.wbActions.current]); await refs.wbWriteQueue.current; render() }
  render()
  return { state, server, refs, calls, clipboard, render, button, formatSelect, settle,
    get tree() { return tree }, set failWrites(value) { failWrites = value }, set writeGate(value) { writeGate = value }, set readGate(value) { readGate = value }, set wrongFormat(value) { wrongFormat = value },
    switch(format) { return settle(() => formatSelect().props.onChange({ target: { value: format } })) },
    click(label) { return settle(() => button(label).props.onClick()) },
    editContent(value) { one(tree, node => node.type === 'textarea' && String(node.props.placeholder || '').startsWith('条目内容'), 'entry textarea').props.onChange({ target: { value } }); render() },
  }
}

test('worldbook selector reads another format without changing the global promptMode; writes stay isolated', async () => {
  const h = harness()
  await h.switch('structured')
  assert.equal(h.state.wbFormat, 'structured')
  assert.equal(h.state.data.config.promptMode, 'tags')
  assert.match(text(h.tree), /正在编辑：结构化自然语言；实际生图：标签/)
  assert.match(text(h.tree), /structured-main-rule/)
  await h.click('编辑')
  h.editContent('中文结构化内容')
  await h.click('🔄 刷新')
  assert.equal(h.server.structured[0].entries[0].content, '中文结构化内容')
  assert.equal(h.server.tags[0].entries[0].content, 'original tags main')
  assert.ok(h.calls.every(call => call.path !== '/config'))
  await h.switch('natural')
  assert.match(text(h.tree), /natural-main-rule/)
  assert.deepEqual(clone(h.state.wbDrafts), {})
})

test('switch flushes the old format before GET, even when a write is already in flight', async () => {
  const h = harness()
  await h.click('编辑')
  h.editContent('pending tags content')
  const gate = deferred(); h.writeGate = gate
  const changing = h.switch('natural')
  await tick(); h.render()
  assert.equal(h.tree.props.disabled, true)
  assert.equal(h.state.wbFormat, 'tags')
  assert.deepEqual(h.calls.map(call => call.path), ['/worldbook-entry'])
  gate.resolve(); await changing
  assert.equal(h.server.tags[0].entries[0].content, 'pending tags content')
  assert.equal(h.server.natural[0].entries[0].content, 'original natural main')
  assert.deepEqual(h.calls.map(call => [call.path, call.query.format || call.body.format]), [
    ['/worldbook-entry', 'tags'], ['/worldbook', 'tags'], ['/worldbook', 'natural'],
  ])
})

test('failed pending save blocks format changes and retains the original draft for retry', async () => {
  const h = harness()
  await h.click('编辑'); h.editContent('must not lose me')
  h.failWrites = true
  await h.switch('structured')
  assert.equal(h.state.wbFormat, 'tags')
  assert.equal(h.state.wbDrafts[0].content, 'must not lose me')
  assert.equal(h.refs.wbPending.current[0].content, 'must not lose me')
  assert.match(h.state.wbNote, /切换已取消/)
  assert.equal(h.calls.some(call => call.query.format === 'structured'), false)
  h.failWrites = false
  await h.switch('structured')
  assert.equal(h.server.tags[0].entries[0].content, 'must not lose me')
  assert.equal(h.state.wbFormat, 'structured')
})

test('book switching also flushes pending edits into the original book, not the same index in another book', async () => {
  const h = harness()
  await h.click('编辑'); h.editContent('main draft')
  const target = one(h.tree, node => node.type === 'button' && text(node).includes('tags-outfits'), 'outfits book button')
  await h.settle(() => target.props.onClick())
  assert.equal(h.state.wbBook, 'outfits')
  assert.equal(h.server.tags[0].entries[0].content, 'main draft')
  assert.equal(h.server.tags[1].entries[0].content, 'original tags outfits')
  assert.deepEqual(clone(h.state.wbDrafts), {})
})

test('add, import, delete and export all carry selected format and book', async () => {
  const h = harness()
  await h.switch('structured')
  await h.click('➕ 新条目')
  assert.equal(h.server.structured[0].entries.length, 2)
  await h.click('📥 导入世界书')
  const paste = one(h.tree, node => node.type === 'textarea' && String(node.props.placeholder || '').startsWith('把世界书 JSON'), 'import textarea')
  paste.props.onChange({ target: { value: 'new structured rules' } }); h.render()
  await h.click('导入这段内容')
  assert.equal(h.server.structured[0].entries[0].content, 'new structured rules')
  await h.click('📤 导出（复制 JSON）')
  assert.match(h.clipboard[0], /new structured rules/)
  await h.click('删')
  assert.equal(h.server.structured[0].entries.length, 0)
  assert.equal(h.server.tags[0].entries.length, 1)
  const operations = h.calls.filter(call => call.method === 'POST' || call.path === '/worldbook-export')
  assert.deepEqual(operations.map(call => call.body?.format || call.query.format), ['structured', 'structured', 'structured', 'structured'])
  assert.ok(operations.every(call => (call.body?.book || call.query.book) === 'main'))
})

test('late refresh of a previous format cannot replace the newly selected format', async () => {
  const h = harness()
  const gate = deferred(); h.readGate = gate
  const refresh = h.click('🔄 刷新')
  await tick()
  await h.switch('structured')
  gate.resolve(); await refresh
  assert.equal(h.state.wbFormat, 'structured')
  assert.match(text(h.tree), /structured-main-rule/)
})

test('format settings navigation saves drafts, never changes prompt mode and stops on failure', async () => {
  const ui = harness()
  await ui.click('编辑'); ui.editContent('before navigation')
  ui.failWrites = true
  await ui.click('前往提示词格式设置')
  assert.equal(ui.state.tab, undefined)
  assert.match(ui.state.wbNote, /未保存/)
  ui.failWrites = false
  await ui.click('前往提示词格式设置')
  assert.equal(ui.state.tab, 'plan')
  assert.equal(ui.server.tags[0].entries[0].content, 'before navigation')
  assert.equal(ui.state.data.config.promptMode, 'tags')
  assert.equal(ui.calls.some(call => call.path === '/config'), false)
})

test('auto effective format is server supplied, never inferred from the editor selection', async () => {
  const ui = harness()
  ui.state.data.config = { promptMode: 'auto', promptEffectiveFormat: 'natural' }
  ui.render()
  assert.match(text(ui.tree), /正在编辑：标签；实际生图：自然语言（自动选择）/)
  delete ui.state.data.config.promptEffectiveFormat
  ui.render()
  assert.match(text(ui.tree), /实际生图：尚未解析/)
})

test('an invalid response format never populates the requested format editor', async () => {
  const h = harness(); h.wrongFormat = true
  await h.switch('mixed')
  assert.equal(h.state.wbFormat, 'tags')
  assert.match(h.state.wbNote, /其他格式/)
  assert.equal(h.state.wbLoading, false)
})
