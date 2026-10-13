import test from 'node:test'
import assert from 'node:assert/strict'
import { registerRequestHooks } from '../tavern-plugin/lib/hooks/request.js'

function preStep({ chat, background = false } = {}) {
  const handlers = {}
  const prepared = []
  const recalled = []
  registerRequestHooks({
    backgroundAgentRunner: { owns: () => background },
    cardMemory: { appendRecall: async ({ decision }) => { recalled.push(chat?.id); return decision } },
    chatForSession: async () => chat,
    ctx: { on: (name, handler) => { handlers[name] = handler } },
    foregroundStrategies: { prepareStep: async input => { prepared.push(input.sessionId); return { ...input.decision, status: true } } },
    requestCoordinates: new Map(),
    requestIdForMessages: () => '',
    sessionStore: { flush: async () => {} },
    tavernRetryLimiter: { handle: async (_payload, next) => next() }
  })
  return { run: header => handlers['agent/pre-step']({ agent: { session: { id: 's1', header } }, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] })), prepared, recalled }
}

test('child agent sessions get no Tavern turn frame or status', async () => {
  const hook = preStep()
  assert.deepEqual(await hook.run({ parentSession: 'game-1' }), { kind: 'enter', messages: [] })
  assert.deepEqual(hook.prepared, [])
})

test('top-level sessions still go through foreground preparation', async () => {
  const hook = preStep()
  assert.equal((await hook.run({})).status, true)
  assert.deepEqual(hook.prepared, ['s1'])
})

test('原生分叉游玩局保留前台准备和卡片记忆召回', async () => {
  const chat = { id: 'fork-game', sessionId: 's1', messages: [] }
  const hook = preStep({ chat })
  assert.equal((await hook.run({ parentSession: 'original-game', isSeeded: true })).status, true)
  assert.deepEqual(hook.prepared, ['s1'])
  assert.deepEqual(hook.recalled, ['fork-game'])
})

test('Tavern 自有后台会话即使找到关联局也不走前台', async () => {
  const hook = preStep({ chat: { id: 'background-owner', messages: [] }, background: true })
  assert.deepEqual(await hook.run({ parentSession: 'game-1' }), { kind: 'enter', messages: [] })
  assert.deepEqual(hook.prepared, [])
  assert.deepEqual(hook.recalled, [])
})
