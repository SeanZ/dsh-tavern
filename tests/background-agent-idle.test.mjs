import assert from 'node:assert/strict'
import test from 'node:test'
import { createBackgroundAgentSessions } from '../tavern-plugin/lib/background-agent-sessions.js'

function harness(t, extra = {}) {
  let time = 0, sequence = 0
  const disk = new Map(), live = new Map(), calls = []
  async function handle(id, session) {
    live.set(id, session)
    return { agent: { session }, async dispose() { calls.push(['dispose', id]); live.delete(id) } }
  }
  const runner = createBackgroundAgentSessions({
    now: () => time, residentIdleMs: 1000, maxResidentSessions: 2, id: () => `idle-${++sequence}`,
    agents: {
      get: id => id.startsWith('parent') ? { id, session: { header: {} } } : undefined,
      create: async ({ sessionId, meta }) => {
        calls.push(['create', sessionId])
        return handle(sessionId, { id: sessionId, header: meta, events: [], append(type, data) { this.events.push({ type, data }) } })
      },
      resume: async ({ resumeSessionId }) => {
        calls.push(['resume', resumeSessionId])
        const saved = structuredClone(disk.get(resumeSessionId))
        assert.ok(saved, 'release must persist before resume')
        return handle(resumeSessionId, { ...saved, append(type, data) { this.events.push({ type, data }) } })
      }
    },
    flushSession: async session => {
      await extra.flush?.()
      disk.set(session.id, structuredClone({ id: session.id, header: session.header, events: session.events }))
    },
    compactAgent: async () => extra.compact?.(),
    ...extra.options
  }, {
    setup: () => () => {},
    execute: async ({ agent, state, traceSessionId }, input) => {
      await extra.work?.(input, state)
      agent.session.append('system/message', { text: input.text || 'task' })
      return traceSessionId
    }
  })
  t.after(() => runner.dispose())
  return { runner, live, disk, calls, tick: n => { time += n }, run: (parent = 'parent-a', text) => runner.run({ sessionId: parent, task: 'candidate', persistent: true, selection: { provider: 'test', model: 'test' }, text }) }
}

test('failed persistence retains instance and backs off before retry', async t => {
  let fail = true, attempts = 0
  const h = harness(t, { flush: async () => { attempts++; if (fail) throw new Error('disk unavailable') } })
  const id = await h.run(); h.tick(1000)
  await h.runner.reapIdle(); assert.equal(h.runner.owns(id), true)
  await h.runner.reapIdle(); assert.equal(attempts, 1)
  fail = false; h.tick(60000); await h.runner.reapIdle()
  assert.equal(h.runner.owns(id), false); assert.equal(attempts, 2)
})

test('本局开了联网搜索：任务自己写明不联网时仍不联网', async t => {
  const seen = []
  const h = harness(t, { options: { resolveWebSearch: async () => true }, work: async (input, state) => { seen.push([input.task, state.input.webSearchEnabled]) } })
  await h.runner.run({ sessionId: 'parent-a', task: 'candidate', persistent: true, selection: { provider: 'test', model: 'test' } })
  await h.runner.run({ sessionId: 'parent-a', task: 'ledger', persistent: true, webSearchEnabled: false, selection: { provider: 'test', model: 'test' } })
  assert.deepEqual(seen, [['candidate', true], ['ledger', false]])
})

test('插件成员：任务在它自己的常驻会话里按顺序跑，和书记的任务互不排队', async t => {
  const { registerPluginMember } = await import('../tavern-plugin/lib/domain/background-members.js')
  const remove = registerPluginMember({ owner: 'npc-plugin', name: 'luna', title: '露娜' })
  t.after(remove)
  const order = [], gates = []
  const h = harness(t, { work: async input => {
    order.push('start:' + input.text)
    if (input.text?.startsWith('luna')) await new Promise(resolve => gates.push(resolve))
    order.push('end:' + input.text)
  } })
  const plugin = text => h.runner.run({ sessionId: 'parent-a', task: 'plugin', pluginName: 'npc-plugin', member: 'plugin:npc-plugin:luna', persistent: true, selection: { provider: 'test', model: 'test' }, text })
  const first = plugin('luna-1'), second = plugin('luna-2')
  await new Promise(resolve => setTimeout(resolve, 20))
  // 书记 is not held up by the plugin member's queue.
  const settlement = await h.run('parent-a', 'settle')
  assert.ok(order.includes('end:settle'))
  assert.deepEqual(order.filter(item => item.includes('luna')), ['start:luna-1'], 'the member runs one task at a time')
  gates.shift()()
  await new Promise(resolve => setTimeout(resolve, 20))
  gates.shift()()
  const [a, b] = await Promise.all([first, second])
  assert.equal(a, b, 'both tasks ran in the member\'s one Session')
  assert.notEqual(a, settlement, 'and not in 书记\'s')
  assert.deepEqual(h.runner.runs('parent-a').filter(run => run.task === 'plugin').map(run => run.member), ['plugin:npc-plugin:luna', 'plugin:npc-plugin:luna'])
})

test('每次后台运行结束都报一次「任务完成」，带任务、成员和成败', async t => {
  const ended = []
  const h = harness(t, { options: { onRunFinished: run => ended.push(run) }, work: async input => { if (input.text === 'bad') throw new Error('坏了') } })
  await h.run('parent-a', 'ok')
  await assert.rejects(h.run('parent-a', 'bad'))
  assert.deepEqual(ended.map(run => [run.sessionId, run.task, run.member, run.status]),
    [['parent-a', 'candidate', 'background', 'completed'], ['parent-a', 'candidate', 'background', 'failed']])
})
