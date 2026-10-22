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
function loadClient() {
  let descriptor
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { descriptor = value } }, setTimeout, clearTimeout }, console })
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
