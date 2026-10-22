import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
const component = source.slice(source.indexOf('function CandidateAction('), source.indexOf('function CandidateDockActions('))
// The replay submit path sits above CandidateAction; slice it with its only helper.

function harness() {
  let storyView = false, running = true, activity = { phase: 'idle', busy: false, role: '' }, regen = null, fail = false, warning = '', canRollback = true, undoTurn = null
  const states = [], calls = [], extraView = {}
  let cursor = 0
  const context = {
    React: {
      Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props, children }),
      useRef: value => ({ current: value }), useEffect() {}, useLayoutEffect() {},
      useState(initial) {
        const index = cursor++
        if (!(index in states)) states[index] = initial
        return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
      }
    },
    useCandidatePanel: () => null, useRegenPanel: () => regen,
    useTavernSessionMode: () => 'story', useTavernStoryViewMode: () => storyView, latestTavernAssistantMessageId: () => 'reply',
    useLiveTavernView: () => ({ view: { canRollback, undoRollbackTurn: undoTurn, ...extraView } }),
    useTavernCoordination: () => ({ view: { activity } }),
    describeTavernActivity: value => value, isPlayMode: () => true,
    window: { confirm: () => { calls.push('confirm'); return true } },
    rpc: async () => { calls.push('rpc'); if (fail) throw new Error('本次回复未完成'); return { view: { rollbackWarning: warning } } },
    historyProjection: { rolledBack: () => calls.push('project'), restored: () => calls.push('restore') },
    setCandidatePanel() { calls.push('set-candidate-panel') }, setRegenPanel() { calls.push('set-regen-panel') }, setCandidateGuidePanel() { calls.push('set-guide-panel') },
    liveTavernView: { invalidate: () => calls.push('refresh-view') },
    tavernCoordination: { invalidate: () => calls.push('refresh-activity') },
    notifyTavernDataChanged: () => calls.push('notify'),
    tavernErrorHub: { report: (name, error) => calls.push(name + ': ' + error.message) },
    submitFailedTurnReplay: async sessionId => { calls.push('replay'); return { view: {} } },
    TavernCompactionAction: function TavernCompactionAction() {}
  }
  const actions = vm.runInNewContext(component + '; ({ CandidateAction, TavernRollbackAction, TavernUndoRollbackAction, TavernMoreActions })', context)
  return {
    calls,
    view(value) { Object.assign(extraView, value) },
    undoTurn(value) { undoTurn = value },
    undo() { cursor = 0; return actions.TavernUndoRollbackAction({ sessionId: 'session', useSession: select => select({ running }) }) },
    playerRound(value) { canRollback = value },
    storyView(value) { storyView = value },
    running(value) { running = value },
    background(value) { activity = value ? { phase: 'running', busy: true, role: 'settlement' } : { phase: 'idle', busy: false, role: '' } },
    activity(value) { activity = value },
    regen(value) { regen = value ? { sessionId: 'session', phase: 'loading' } : null },
    fail(value) { fail = value }, warning(value) { warning = value },
    buttons() {
      cursor = 0
      return actions.CandidateAction({ sessionId: 'session', messageId: 'reply',
        useSession: select => select({ running }), useChat: select => select({}), useInput: select => select({ draft: '' })
      }).children.filter(Boolean)
    },
    button() {
      cursor = 0
      return actions.TavernRollbackAction({ sessionId: 'session',
        useSession: select => select({ running }), useChat: select => select({})
      })
    },
    more() {
      cursor = 0
      return actions.TavernMoreActions({ sessionId: 'session',
        useSession: select => select({ running }), useChat: select => select({})
      })
    }
  }
}

test('开场白不显示正文重生成入口，正式玩家轮次完成后只显示一个入口', () => {
  const h = harness()
  h.running(false); h.playerRound(false)
  assert.deepEqual(h.buttons().map(button => button.children[0]), ['生成候选项'])
  h.playerRound(true)
  assert.deepEqual(h.buttons().map(button => button.children[0]), ['生成候选项', '重新生成正文'])
  h.playerRound(false)
  assert.deepEqual(h.buttons().map(button => button.children[0]), ['生成候选项'])
})

test('实际回退组件在前台、后台和重生成期间禁用，完成后允许点击', async () => {
  const h = harness()
  for (const phase of ['front', 'background', 'regen']) {
    h.running(phase === 'front'); h.background(phase === 'background'); h.regen(phase === 'regen')
    const button = h.button()
    assert.equal(button.props.disabled, true)
    await button.props.onClick()
    assert.deepEqual(h.calls, [], '禁用时即便直接调用处理器也不能发起请求')
  }
  h.running(false); h.background(false); h.regen(false)
  assert.equal(h.button().props.disabled, false)
  await h.button().props.onClick()
  assert.ok(h.calls.includes('project'))
  assert.ok(!h.calls.includes('confirm'), '点击回退直接执行，不弹确认框')
  assert.equal(h.button().props.disabled, false)
})

// 故事视图模式（C4 开关）下，重新生成、失败轮重放与撤回、编辑正文、回退本轮由楼层操作和输入框状态条承担。
const labels = buttons => buttons.map(button => button.children[0])
function menuItems(more) {
  const menu = more.children[1]
  return menu.children.filter(Boolean).map(item => typeof item.type === 'function' ? item.type.name : item.children[0])
}

test('故事视图模式开启时 dock 只留生成候选项，关闭时照旧显示重新生成与撤回', () => {
  const h = harness()
  h.running(false)
  h.view({ canReplayFailedTurn: false })
  assert.deepEqual(labels(h.buttons()), ['生成候选项', '重新生成正文'])
  h.storyView(true)
  assert.deepEqual(labels(h.buttons()), ['生成候选项'])
  h.view({ canReplayFailedTurn: true })
  assert.deepEqual(labels(h.buttons()), ['生成候选项'], '失败轮重放与撤回归输入框状态条')
  h.storyView(false)
  assert.deepEqual(labels(h.buttons()), ['生成候选项', '重新生成本轮', '撤回这条输入'])
})

test('故事视图模式开启时「更多」不含编辑正文、回退本轮与恢复错误提示，其余照旧', () => {
  const h = harness()
  const all = ['TavernStopBackgroundAction', 'TavernEditBodyAction', 'TavernRollbackAction', 'TavernUndoRollbackAction', '恢复全部错误提示', 'TavernCompactionAction']
  assert.deepEqual(menuItems(h.more()), all)
  h.storyView(true)
  assert.deepEqual(menuItems(h.more()), ['TavernStopBackgroundAction', 'TavernUndoRollbackAction', 'TavernCompactionAction'])
})
