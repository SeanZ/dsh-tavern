import test from 'node:test'
import assert from 'node:assert/strict'
import { registerRequestHooks } from '../tavern-plugin/lib/hooks/request.js'

function preStep(chats = {}) {
  const handlers = {}
  const prepared = []
  registerRequestHooks({
    backgroundAgentRunner: { owns: () => false },
    cardMemory: { appendRecall: async ({ decision }) => decision },
    chatForSession: async id => chats[id],
    ctx: { on: (name, handler) => { handlers[name] = handler } },
    foregroundStrategies: { prepareStep: async input => { prepared.push(input.sessionId); return { ...input.decision, status: true } } },
    requestCoordinates: new Map(),
    requestIdForMessages: () => '',
    sessionStore: { flush: async () => {} },
    tavernRetryLimiter: { handle: async (_payload, next) => next() }
  })
  return { run: header => handlers['agent/pre-step']({ agent: { session: { id: 's1', header } }, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] })), prepared }
}

test('child agent sessions get no Tavern turn frame or status', async () => {
  const hook = preStep()
  assert.deepEqual(await hook.run({ parentSession: 'game-1' }), { kind: 'enter', messages: [] })
  assert.deepEqual(hook.prepared, [])
})

test('recovery reads post-preparation state rather than overwriting fresh pending context with old data', async () => {
  const handlers = {}
  const makeChat = text => ({ messages: [], worldbookStrategy: 'native-skills', worldBookVirtualState: { schemaVersion: 1, scope: 'scope', entries: { a: { text, renderHash: text } } } })
  let chat = makeChat('old')
  const fresh = { role: 'user', content: [{ type: 'text', text: 'new' }], source: { kind: 'plugin:dsh-tavern', virtualWorldbook: { scope: 'scope', entries: { a: 'new' } } } }
  registerRequestHooks({
    backgroundAgentRunner: { owns: () => false },
    cardMemory: { appendRecall: async ({ decision }) => decision },
    chatForSession: async () => chat,
    ctx: { on: (name, handler) => { handlers[name] = handler } },
    foregroundStrategies: { prepareStep: async () => { chat = makeChat('new'); return { kind: 'enter', messages: [fresh] } } },
    projectWorldbookRecovery: async () => assert.fail('fresh pending body already covers updated state'),
    requestCoordinates: new Map(), requestIdForMessages: () => '',
    sessionStore: { flush: async () => {} }, tavernRetryLimiter: { handle: async (_payload, next) => next() }
  })
  const result = await handlers['agent/pre-step']({ agent: { session: { id: 's1', header: {}, events: [], surface: { nodes: [] } } }, step: 2, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(result.messages, [fresh])
})
