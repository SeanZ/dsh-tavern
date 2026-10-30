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

test('历史编辑等待退休句柄完成释放，再恢复同一会话并释放临时句柄', async t => {
  let release, entered = false
  const gate = new Promise(resolve => { release = resolve })
  const h = harness(t, { work: async (_input, state) => { state.abandoned = true }, flush: () => gate })
  t.after(() => release())
  const id = await h.run()
  const edit = h.runner.withSession(id, 'parent-a', async session => {
    entered = true
    assert.equal(session.id, id)
    assert.equal(session.events.filter(e => e.type === 'system/message').length, 1)
    return 'edited'
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(entered, false, '不能借用还在释放中的 Agent')
  release()
  assert.equal(await edit, 'edited')
  assert.deepEqual(h.calls.slice(-3), [['dispose', id], ['resume', id], ['dispose', id]])
})

test('历史编辑与空闲回收串行；编辑失败不释放仍由管理器拥有的句柄', async t => {
  const h = harness(t)
  const id = await h.run()
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const ready = new Promise(resolve => { entered = resolve })
  const edit = h.runner.withSession(id, 'parent-a', async () => { entered(); await gate; throw new Error('edit failed') })
  const rejected = assert.rejects(edit, /edit failed/)
  await ready
  h.tick(1000)
  await h.runner.reapIdle()
  assert.equal(h.runner.owns(id), true)
  release(); await rejected
  assert.equal(h.runner.owns(id), true)
  assert.equal(h.calls.some(call => call[0] === 'dispose'), false)
})

test('后台任务长时间运行时，历史编辑在限定时间内明确报忙，超时的编辑之后也不再执行', async t => {
  let release, entered = false
  const gate = new Promise(resolve => { release = resolve })
  const h = harness(t, { options: { editWaitMs: 50 }, work: input => input.text === 'long' ? gate : undefined })
  const id = await h.run()
  const long = h.run('parent-a', 'long')
  t.after(() => release())
  const started = Date.now()
  await assert.rejects(h.runner.withSession(id, 'parent-a', async () => { entered = true }), error => error.code === 'BACKGROUND_BUSY' && /后台任务仍在运行/.test(error.message))
  assert.ok(Date.now() - started < 1000, '不能等后台任务跑完')
  release()
  await long
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(entered, false, '超时作废的编辑不能在任务结束后补做')
  // 排在空闲队列上的编辑照常进入。
  assert.equal(await h.runner.withSession(id, 'parent-a', async () => 'edited'), 'edited')
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


test('成员历史编辑等待自己的任务，独立成员仍能运行，编辑期间不会被回收', async t => {
  const { registerPluginMember } = await import('../tavern-plugin/lib/domain/background-members.js')
  t.after(registerPluginMember({ owner: 'edit-plugin', name: 'reader', title: '读者' }))
  let releaseTask, releaseEdit, entered = false
  const taskGate = new Promise(resolve => { releaseTask = resolve })
  const editGate = new Promise(resolve => { releaseEdit = resolve })
  const h = harness(t, { work: input => input.text === 'long' ? taskGate : undefined })
  t.after(() => { releaseTask(); releaseEdit() })
  const runMember = text => h.runner.run({ sessionId: 'parent-a', task: 'plugin', pluginName: 'edit-plugin', member: 'plugin:edit-plugin:reader', persistent: true, selection: { provider: 'test', model: 'test' }, text })
  const id = await runMember('initial')
  const active = runMember('long')
  const edit = h.runner.withSession(id, 'parent-a', async session => { entered = true; assert.equal(session.id, id); await editGate })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(entered, false, '不得跨过该成员的在途任务')
  await h.run('parent-a', 'independent')
  releaseTask(); await active
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(entered, true)
  h.tick(1000); await h.runner.reapIdle()
  assert.equal(h.runner.owns(id), true, '回收须等待同一成员的编辑结束')
  releaseEdit(); await edit
})
