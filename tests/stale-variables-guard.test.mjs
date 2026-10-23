import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createStaleVariablesGuard, dropQueuedPlayerInputs, STALE_VARIABLES_SEND_ERROR } from '../tavern-plugin/lib/domain/stale-variables-guard.js'
import { createForegroundHandoff } from '../tavern-plugin/lib/domain/foreground-handoff.js'
import { createNativePlayOrchestrationStrategy } from '../tavern-plugin/lib/domain/foreground-orchestration-strategies.js'
import { foldStoryRounds } from '../tavern-plugin/lib/domain/story-rounds.js'

const player = (id, text = id) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const regen = id => ({ id, role: 'user', source: { kind: 'plugin:dsh-tavern-regen', regenerationId: 'op-' + id }, content: [{ type: 'text', text: '重新生成' }] })

function fakeAgent(queue) {
  return { inbox: { nextTurn: queue, remove(id) { this.nextTurn = this.nextTurn.filter(message => message.id !== id) } } }
}

test('变量未重算时拒绝新玩家输入并撤下排队的玩家输入；重新生成、未标记或非玩家输入照常', async () => {
  let stale = true
  const agent = fakeAgent([player('b'), regen('r')])
  const guard = createStaleVariablesGuard({ isStale: async () => stale, agentFor: () => agent })
  await guard({ sessionId: 's1', playerInput: false })
  assert.equal(agent.inbox.nextTurn.length, 2, '重新生成的回合不检查，也不动队列')
  await assert.rejects(guard({ sessionId: 's1', playerInput: true }), error => error.message === STALE_VARIABLES_SEND_ERROR)
  assert.deepEqual(agent.inbox.nextTurn.map(message => message.id), ['r'], '只撤下玩家输入')
  stale = false
  await guard({ sessionId: 's1', playerInput: true })
  assert.equal(dropQueuedPlayerInputs(undefined), 0)
  assert.equal(STALE_VARIABLES_SEND_ERROR, '变量未重算：请先按当前正文重新结算（或重新生成），再发送')
})

test('回合准备先等后台结算完成再检查标记：刚点的重新结算成功后可以发送', async () => {
  const order = []
  let stale = true
  const handoff = createForegroundHandoff({
    store: { async chatForSession() { return { id: 'c1', mode: 'story', messages: [] } } },
    tasks: { activity() { return { phase: 'idle', busy: false, role: '' } } },
    async queueBackground() {},
    waitBackground: async () => { order.push('wait'); stale = false },
    rejectStaleTurn: createStaleVariablesGuard({ isStale: async () => { order.push('check:' + stale); return stale }, agentFor: () => undefined }),
    clearFailedTurns: async () => { order.push('clear') },
    turns: { async finalize() {}, async discard() {}, async prepare() { order.push('prepare') } }
  })
  await handoff.prepare({ sessionId: 's1', turn: 3, userText: '前进', playerInput: true })
  assert.deepEqual(order, ['wait', 'check:false', 'clear', 'prepare'])
})

test('标记仍在时拒绝发生在清理失败回合与输入模板之前', async () => {
  const order = []
  const handoff = createForegroundHandoff({
    store: { async chatForSession() { return { id: 'c1', mode: 'story', messages: [] } } },
    tasks: { activity() { return { phase: 'idle', busy: false, role: '' } } },
    async queueBackground() {},
    rejectStaleTurn: createStaleVariablesGuard({ isStale: async () => true, agentFor: () => undefined }),
    clearFailedTurns: async () => { order.push('clear') },
    turns: { async finalize() {}, async discard() {}, async prepare() { order.push('prepare') } }
  })
  await assert.rejects(handoff.prepare({ sessionId: 's1', turn: 3, userText: '前进', playerInput: true }), /变量未重算/)
  assert.deepEqual(order, [])
  await handoff.prepare({ sessionId: 's1', turn: 3, userText: '', playerInput: false })
  assert.deepEqual(order, ['clear', 'prepare'], '重新生成的合成输入不拦')
})

test('故事折叠：被拒回合准备阶段撤下的排队玩家输入并入 attempt.inputs；回合正常继续或被打断时不并入', () => {
  let seq = 0
  const at = (type, data, extra = {}) => ({ type, seq: ++seq, time: 1, data, ...extra })
  const queued = [player('a', '第一条'), player('b', '第二条')]
  const base = [
    at('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [queued[0]] }),
    at('turn/start', { turn: 1 }),
    at('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
    at('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [queued[1]] }),
    at('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
  ]
  const rejected = foldStoryRounds([...base, at('turn/end', { turn: 1, reason: { kind: 'error', error: { message: STALE_VARIABLES_SEND_ERROR } } })]).attempt
  assert.deepEqual(rejected.inputs.map(input => input.text), ['第一条', '第二条'])
  assert.equal(rejected.accepted, false)
  assert.equal(rejected.error, STALE_VARIABLES_SEND_ERROR)
  const aborted = foldStoryRounds([...base, at('turn/end', { turn: 1, reason: { kind: 'aborted' } })]).attempt
  assert.deepEqual(aborted.inputs.map(input => input.text), ['第一条'], '打断时撤下的是玩家自己取消的，不并入')
  const proceeded = foldStoryRounds([...base, at('step/start', { turn: 1, step: 1 }), at('turn/end', { turn: 1, reason: { kind: 'error', error: { message: '模型失败' } } })]).attempt
  assert.deepEqual(proceeded.inputs.map(input => input.text), ['第一条'], '模型步骤已开始，撤下与本轮无关')
})

test('真实宿主：变量未重算时新回合早期失败、排队的第二条一并拒绝不卡住；重新生成与未标记卡照常', { skip: !process.env.DSH_BOOT_MODULE, timeout: 30000 }, async t => {
  const bootUrl = pathToFileURL(process.env.DSH_BOOT_MODULE)
  const { boot } = await import(bootUrl.href)
  const { LlmAdapter } = await import(new URL('../../dsh-llm/lib/index.js', bootUrl))
  const root = await mkdtemp(join(tmpdir(), 'stale-guard-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const packages = ['dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-session-query', 'dsh-subagent', 'dsh-token-meter', 'dsh-agent-loop', 'dsh-attachment-local', 'dsh-fs-local', 'dsh-working-directory']
  await writeFile(join(root, 'host.yml'), packages.map(name => '- name: ' + new URL('../../' + name + '/lib/index.js', bootUrl).href + '\n').join(''))
  const ctx = await boot('stale-guard-test', join(root, 'host.yml'))
  t.after(() => ctx.fiber.dispose())
  let requests = 0
  class Model extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id } }
    async *stream() {
      requests++
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['stale-guard'], new Model())
  const handle = await ctx.agents.create({ sessionId: 'stale-guard', agentOptions: { provider: 'stale-guard', model: 'fixed' } })
  t.after(() => handle.dispose())
  const agent = handle.agent

  let stale = true, gate = null, entered = null
  const handoff = createForegroundHandoff({
    store: { async chatForSession() { return { id: 'c1', mode: 'story', messages: [] } } },
    tasks: { activity() { return { phase: 'idle', busy: false, role: '' } } },
    async queueBackground() {},
    // 第一条停在准备阶段等后台，让第二条进入排队。
    waitBackground: async () => { if (gate) { entered(); await gate } },
    rejectStaleTurn: createStaleVariablesGuard({ isStale: async () => stale, agentFor: () => agent }),
    turns: { async finalize() {}, async discard() {}, async prepare(input) { return { ready: true, frame: { frameId: 'f', userInput: { projectedText: input.userText } } } } }
  })
  const strategy = createNativePlayOrchestrationStrategy({
    async modeFor() { return 'story' },
    filterMessages: messages => messages,
    async resolvePreset() { return null },
    prepareTurn: input => handoff.prepare(input),
    appendFrame: input => ({ messages: input.messages, receipt: {} }),
    recordFrame() {}
  })
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    return await strategy.prepareStep({ sessionId: 'stale-guard', payload, decision, chat: { id: 'c1', mode: 'story' }, requestId: '' })
  })
  const events = () => agent.session.snapshotEvents()

  let release
  gate = new Promise(resolve => { release = resolve })
  const waiting = new Promise(resolve => { entered = resolve })
  agent.followup(player('a', '第一条'))
  await waiting
  agent.followup(player('b', '第二条'))
  assert.equal(agent.inbox.nextTurn.length, 1, '第二条在排队')
  gate = null
  release()
  await agent.whenIdle()
  const ends = events().filter(event => event.type === 'turn/end')
  assert.equal(ends.length, 1, '排队的第二条没有另开回合')
  assert.equal(ends[0].data.reason.kind, 'error')
  assert.match(ends[0].data.reason.error.message, /变量未重算：请先按当前正文重新结算（或重新生成），再发送/)
  assert.equal(events().filter(event => event.type === 'user/message').length, 0, '输入未被接纳')
  assert.equal(agent.inbox.nextTurn.length, 0, '队列已清空，不会暂停卡住')
  assert.equal(requests, 0, '没有发出模型请求')
  const attempt = foldStoryRounds(events()).attempt
  assert.deepEqual([attempt.phase, attempt.accepted, attempt.inputs.map(input => input.text)], ['error', false, ['第一条', '第二条']], '两条文字都可恢复')

  // 重新生成（含改写）的合成输入不受标记影响。
  agent.followup(regen('r1'))
  await agent.whenIdle()
  assert.equal(events().filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'completed')
  assert.equal(requests, 1)

  // 未标记（非 MVU 卡或已重新结算）时玩家输入照常。
  stale = false
  agent.followup(player('c', '第三条'))
  await agent.whenIdle()
  assert.equal(events().filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'completed')
  assert.deepEqual(events().filter(event => event.type === 'user/message' && event.data.source?.kind === 'user').map(event => event.data.id), ['c'])
  assert.equal(requests, 2)
})

test('插件接入：回合准备用存档最新楼层的官方 MVU 标记判断，前台 agent 取自 agents 注册表', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
  assert.match(source, /rejectStaleTurn: createStaleVariablesGuard\(\{\s*isStale: async sessionId => \{\s*const chat = await chatHeaderWithLatestFloors\(sessionId, 2\)\s*return Boolean\(chat && chat\.mvu\?\.enabled === true && chat\.mvu\.owner === 'official' && staleVariablesOf\(chat\)\)/)
  assert.match(source, /agentFor: sessionId => agentRegistry\.get\(sessionId\)/)
})
