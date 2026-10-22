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
