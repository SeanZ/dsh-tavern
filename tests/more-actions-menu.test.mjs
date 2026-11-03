import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../tavern-plugin/src/client/features/play-turn-actions.js', import.meta.url), 'utf8')
const component = source.slice(source.indexOf('function TavernMoreActions('))

test('更多菜单挂到 body，点击菜单内部保持打开，选项、外部及 Escape 关闭并清理监听', () => {
  const states = [], refs = [], effects = [], events = new Map(), body = {}
  let state = 0, ref = 0
  const action = () => null
  const context = {
    React: {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useState(value) { const i = state++; if (!(i in states)) states[i] = value; return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next }] },
      useRef(value) { return refs[ref++] ||= { current: value } },
      useLayoutEffect() {}, useEffect(run) { effects.push(run) }
    },
    ReactDOM: { createPortal: (child, target) => ({ child, target }) },
    document: { body, addEventListener: (name, fn) => events.set(name, fn), removeEventListener: (name, fn) => { if (events.get(name) === fn) events.delete(name) } },
    useTavernStoryViewMode: () => false,
    TavernStopBackgroundAction: action, TavernEditBodyAction: action, TavernRollbackAction: action,
    TavernUndoRollbackAction: action, TavernDebugButton: action, TavernCompactionAction: action
  }
  const render = vm.runInNewContext(component + '; TavernMoreActions', context)
  const draw = () => { state = 0; ref = 0; effects.length = 0; return render({ sessionId: 'menu' }) }
  let tree = draw()
  assert.equal(tree.children[1].target, body)
  assert.equal(tree.children[1].child.props.hidden, true)
  tree.children[0].props.onClick()
  tree = draw()
  assert.equal(tree.children[1].child.props.hidden, false)
  const triggerTarget = {}, menuTarget = {}
  refs[0].current = { contains: target => target === triggerTarget }
  refs[2].current = { contains: target => target === menuTarget }
  const cleanup = effects[0]()
  events.get('pointerdown')({ target: menuTarget })
  assert.equal(states[0], true)
  events.get('pointerdown')({ target: triggerTarget })
  assert.equal(states[0], true)
  tree.children[1].child.props.onClick({ target: { closest: () => null } })
  assert.equal(states[0], true)
  tree.children[1].child.props.onClick({ target: { closest: () => ({}) } })
  assert.equal(states[0], false)
  tree.children[0].props.onClick()
  events.get('keydown')({ key: 'Escape' })
  assert.equal(states[0], false)
  tree.children[0].props.onClick()
  events.get('pointerdown')({ target: {} })
  assert.equal(states[0], false)
  cleanup()
  assert.equal(events.size, 0)
})
