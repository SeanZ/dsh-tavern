import test from 'node:test'
import assert from 'node:assert/strict'
import { interruptStoryQueue } from '../tavern-plugin/lib/domain/interrupt-story-queue.js'
import { foldStoryRounds } from '../tavern-plugin/lib/domain/story-rounds.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

function fixture() {
  const first = { id: 'first', content: [{ type: 'text', text: '先到' }], source: { kind: 'user' } }
  const last = {
    id: 'last',
    content: [{ type: 'image', url: 'local-fixture' }],
    source: { kind: 'user', rpcId: 'fixture' }
  }
  const calls = []
  const agent = {
    status: 'running',
    session: { events: [{ type: 'turn/start', data: { turn: 4 } }] },
    inbox: {
      nextTurn: [first, last],
      remove(id) {
        calls.push('remove')
        this.nextTurn = this.nextTurn.filter((item) => item.id !== id)
      }
    },
    cancel(reason, options) {
      calls.push(['cancel', reason, options])
    },
    followup(message) {
      calls.push('followup')
      this.inbox.nextTurn.push(message)
    }
  }
  return { agent, first, last, calls }
}
test('取消后唤醒同一队尾消息，保留 FIFO、消息身份和附件', () => {
  const f = fixture()
  assert.deepEqual(interruptStoryQueue(f.agent, 4), { interrupted: true })
  assert.deepEqual(f.calls, [['cancel', { kind: 'user' }, { keepInbox: true }], 'remove', 'followup'])
  assert.equal(f.agent.inbox.nextTurn[0], f.first)
  assert.equal(f.agent.inbox.nextTurn[1], f.last)
})
test('过期回合、空队列、空闲及缺失 agent 不产生副作用', () => {
  const f = fixture()
  for (const turn of [3, 5]) assert.equal(interruptStoryQueue(f.agent, turn).interrupted, false)
  f.agent.status = 'idle'
  assert.equal(interruptStoryQueue(f.agent, 4).interrupted, false)
  f.agent.status = 'running'
  f.agent.inbox.nextTurn = []
  assert.equal(interruptStoryQueue(f.agent, 4).interrupted, false)
  assert.equal(interruptStoryQueue(undefined, 4).interrupted, false)
  assert.deepEqual(f.calls, [])
  assert.throws(() => interruptStoryQueue(f.agent, NaN), /原生回合/)
})

test('真实宿主取消后继续消费原队列且只消费一次', { skip: !process.env.DSH_BOOT_MODULE, timeout: 20000 }, async (t) => {
  let ctx, entered
  const started = new Promise((resolve) => {
    entered = resolve
  })
  let first = true
  const bootUrl = pathToFileURL(process.env.DSH_BOOT_MODULE)
  const { boot } = await import(bootUrl.href)
  const { LlmAdapter } = await import(new URL('../../dsh-llm/lib/index.js', bootUrl))
  const root = await mkdtemp(join(tmpdir(), 'interrupt-queue-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const packages = [
    'dsh-system-prompt',
    'dsh-tools',
    'dsh-agent',
    'dsh-llm',
    'dsh-session',
    'dsh-session-projection',
    'dsh-session-query',
    'dsh-subagent',
    'dsh-token-meter',
    'dsh-agent-loop',
    'dsh-attachment-local',
    'dsh-fs-local',
    'dsh-working-directory'
  ]
  await writeFile(
    join(root, 'host.yml'),
    packages.map((name) => '- name: ' + new URL('../../' + name + '/lib/index.js', bootUrl).href + '\n').join('')
  )
  ctx = await boot('queue-test', join(root, 'host.yml'))
  t.after(() => ctx.fiber.dispose())
  class Model extends LlmAdapter {
    async resolveModel(provider, id) {
      return { provider, id, name: id }
    }
    async *stream(input) {
      if (first) {
        first = false
        entered()
        await new Promise((resolve) => input.signal.addEventListener('abort', resolve, { once: true }))
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['queue-test'], new Model())
  const handle = await ctx.agents.create({
    sessionId: 'queue-test',
    agentOptions: { provider: 'queue-test', model: 'fixed' }
  })
  t.after(() => handle.dispose())
  const agent = handle.agent
  const message = (id) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: id }] })
  agent.followup(message('active'))
  await started
  agent.followup(message('next-1'))
  agent.followup(message('next-2'))
  assert.equal(interruptStoryQueue(agent, 1).interrupted, true)
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  assert.deepEqual(
    events.filter((e) => e.type === 'user/message' && e.data.source?.kind === 'user').map((e) => e.data.id),
    ['active', 'next-1', 'next-2']
  )
  assert.equal(events.find((e) => e.type === 'turn/end').data.reason.kind, 'aborted')
  // 被自动打断的那一轮在故事折叠里是 superseded，不再报告为「上一轮已中断」。
  assert.deepEqual(
    foldStoryRounds(events).abandoned.map((item) => [item.text, item.reason]),
    [['active', 'superseded']]
  )
  assert.equal(agent.inbox.nextTurn.length, 0)
})
