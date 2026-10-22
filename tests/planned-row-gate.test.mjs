import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
const element = (type, props, ...children) => ({ type, props: { ...props, ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } })
const React = {
  createElement: element, Fragment: 'Fragment', memo: value => value, forwardRef: value => value, createContext: () => ({}),
  useMemo: fn => fn(), useCallback: fn => fn, useRef: value => ({ current: value }), useEffect() {}, useLayoutEffect() {},
  useState: value => [typeof value === 'function' ? value() : value, () => {}], useSyncExternalStore: (_subscribe, read) => read()
}
function loadClient(host = {}) {
  let descriptor
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { descriptor = value } }, setTimeout, clearTimeout, ...host }, console })
  return descriptor.factory(name => name === 'react' ? React : {})
}
function chatRows(client) {
  const rows = {}
  const ctx = { sessions: {}, get: () => null, effect(run) { try { run() } catch (_) {} } }
  const slots = { inject: (_name, run) => run(), register(options, component) { if (options.name === 'conversation.chat.node') rows[options.key] = component; return () => {} } }
  client.createTavernAssistantRendererFeatureModule().register({ ctx, slots })
  return rows
}
const at = turn => ({ kind: 'step', turn: { turn, status: 'closed' } })

test('行计划隐藏的用户行与正文行在自身 hook 之前返回 null', () => {
  const client = loadClient()
  client.liveTavernView.setView('s1', { transcriptTurns: { 5: { input: 0, reply: 0 }, 6: { input: 1, reply: 0 } }, transcriptFrom: null })
  const rows = chatRows(client)
  // Only the gate renders here: a hidden row returns null and never builds its own row.
  const render = (key, turn, data) => {
    const gate = rows[key]({ sessionId: 's1', node: { kind: key, data, location: at(turn) } })
    return gate.type(gate.props)
  }
  const reply = { status: 'completed', blocks: [], finalNode: { seq: 9, messageId: 'a5' } }
  assert.equal(render('user', 5, { time: 1, content: [] }), null, '回退掉的输入行')
  assert.equal(render('assistant-step', 5, reply), null, '回退掉的正文行')
  assert.equal(render('assistant-step', 6, reply), null, '保留输入轮不画正文')
  const shown = render('user', 6, { time: 2, content: [] })
  assert.equal(shown.props.node.location.turn.turn, 6, '保留输入轮照常画玩家输入')
  assert.ok(render('assistant-step', 7, reply), '计划未列出的回合照常显示')
})

const find = (tree, match) => !tree || typeof tree !== 'object' ? null : match(tree) ? tree
  : [tree.props?.children].flat().reduce((found, child) => found || find(child, match), null)

test('用户行从回合尾读取分叉目标，不再扫描聊天节点', () => {
  const client = loadClient()
  client.liveTavernView.setView('s2', { mode: 'story', transcriptTurns: null, forkTurnsByMessageId: { a6: 3 } })
  const rows = chatRows(client)
  const selectors = []
  const gate = rows.user({
    sessionId: 's2', node: { kind: 'user', data: { time: 2, content: [{ type: 'text', text: '第三句' }] }, location: at(6) },
    useChat: select => { selectors.push(select); return select({ legacy: { nodes: [] } }) },
    useTurnData: key => key === 'turn-tail' ? { turn: 6, closing: { finalNode: { seq: 30, messageId: 'a6' } } } : undefined,
    useSession: select => select({ running: false }), renderMessageImages: () => null
  })
  const row = gate.props.children
  const tree = row.type(row.props)
  assert.ok(find(tree, node => node.props?.className === 'dsh-tavern-user-fork'), '回合尾的收尾回复给出分叉按钮')
  assert.equal(selectors.length, 1, '只剩「最后一条可见输入」一个聊天选择器')
})

test('同一份节点列表和行计划只扫描一次最后可见输入', () => {
  const client = loadClient()
  const list = [{ kind: 'user', turn: 0 }, { kind: 'assistant', turn: 2 }, { kind: 'user', turn: 0 }, { kind: 'assistant', turn: 5 }]
  let reads = 0
  const nodes = new Proxy(list, { get(target, key) { if (/^\d+$/.test(String(key))) reads++; return target[key] } })
  const turns = { 5: { input: 0, reply: 0 } }
  assert.equal(client.latestTavernUserTurn({ legacy: { nodes } }, { turns, from: null }), 2)
  const first = reads
  assert.ok(first > 0)
  for (let row = 0; row < 50; row++) assert.equal(client.latestTavernUserTurn({ legacy: { nodes } }, { turns, from: null }), 2)
  assert.equal(reads, first, '其余用户行直接复用结果')
  assert.equal(client.latestTavernUserTurn({ legacy: { nodes } }, { turns: {}, from: null }), 5, '行计划变化后重新判断')
})

function templateRows(client) {
  const replyProjections = Array.from({ length: 10 }, (_, index) => ({ turn: index + 1, version: 2, parts: [] }))
  client.liveTavernView.setView('s3', { mode: 'story', transcriptTurns: null, replyProjections, inputTemplateDisplays: { 6: '<b>旧模板</b>', 9: '<b>新模板</b>' } })
  const rows = chatRows(client)
  const render = turn => {
    const gate = rows.user({
      sessionId: 's3', node: { kind: 'user', data: { time: turn, content: [{ type: 'text', text: '输入' + turn }] }, location: at(turn) },
      useChat: select => select({ legacy: { nodes: [] } }), useTurnData: () => undefined,
      useSession: select => select({ running: false }), renderMessageImages: () => null
    })
    return gate.props.children.type(gate.props.children.props)
  }
  return render
}
const frame = node => node.props?.partIndex === 'user-template'
const button = node => node.type === 'button' && node.props.children === '渲染此轮'

test('用户输入模板与助手 HTML 同一渲染窗口：窗口外只显示文字和「渲染此轮」', () => {
  const render = templateRows(loadClient())
  const old = render(6)
  assert.equal(find(old, frame), null, '窗口外的模板不建 iframe')
  assert.ok(find(old, button))
  const recent = render(9)
  assert.ok(find(recent, frame), '窗口内的模板照常渲染')
  assert.equal(find(recent, button), null)
})

test('手机布局只留最近 1 轮活 iframe，桌面保持 3 轮', () => {
  const phone = templateRows(loadClient({ matchMedia: query => ({ matches: query === '(max-width: 1023px)' }) }))
  assert.equal(find(phone(9), frame), null, '手机上倒数第二轮已收起')
  const desktop = templateRows(loadClient({ matchMedia: () => ({ matches: false }) }))
  assert.ok(find(desktop(9), frame), '桌面上倒数第二轮仍渲染')
  assert.equal(find(desktop(6), frame), null)
})

test('会话级行投影只在聊天行挂载时观察 DOM，其他视图下不建 MutationObserver', () => {
  const observers = []
  class MutationObserver { constructor(callback) { this.callback = callback; observers.push(this) } observe() {} disconnect() { this.disconnected = true } }
  const host = { MutationObserver, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, localStorage: { getItem: () => null, removeItem() {} }, addEventListener() {}, removeEventListener() {} }
  let descriptor
  const effects = { ...React, useEffect: run => { run() } }
  const context = { window: { __ModuleLoader__: { load(value) { descriptor = value } }, setTimeout, clearTimeout, ...host }, console }
  vm.runInNewContext(source, context)
  const client = descriptor.factory(name => name === 'react' ? effects : {})
  // The projection observes document.body; the bundle itself loads without a page.
  context.document = { body: {}, querySelectorAll: () => [] }
  const docks = {}
  const ctx = { sessions: { subagentAddress: () => null }, get: () => null, effect(run) { try { run() } catch (_) {} } }
  const slots = { inject: (_name, run) => run(), register(options, component) { docks[options.id || options.key] = component; return () => {} } }
  client.createPlayControlsFeatureModule().register({ ctx, slots })
  const projection = docks['dsh-tavern-question']({ sessionId: 's5' }).props.children.find(child => String(child.props.key).startsWith('history:'))
  const dockProps = { sessionId: 's5', useSession: select => select({ running: false }), useChat: select => select({ legacy: { nodes: [] } }) }
  projection.type(dockProps)
  assert.equal(observers.length, 0, '没有聊天行（故事视图或其他视图）时不观察')
  client.createTavernAssistantRendererFeatureModule().register({ ctx, slots })
  const gate = docks.user({ sessionId: 's5', node: { kind: 'user', data: { time: 1, content: [] }, location: at(1) } })
  gate.type(gate.props)
  projection.type(dockProps)
  assert.equal(observers.length, 1, '聊天行挂载后恢复观察')
})
