import { sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createInitializationNative } from './fixtures/conversation-initialization-native.mjs'
import { app, base, saveTemplate } from './fixtures/foreground-preparation.mjs'
import { createContextPlanner } from '../tavern-plugin/lib/domain/context-planner.js'
import { createForegroundOrchestrationStrategies } from '../tavern-plugin/lib/domain/foreground-orchestration-strategies.js'
import { createForegroundFrameSessionAdapter } from '../tavern-plugin/lib/domain/foreground-frame-session-adapter.js'
import { registerTurnLifecycleHooks } from '../tavern-plugin/lib/hooks/turn-lifecycle.js'
import { registerRequestHooks } from '../tavern-plugin/lib/hooks/request.js'

for (const target of [1, 'staged']) test(`真实宿主首个模型请求使用 CAS 重试后的模板状态：${target}`, {
  skip: !process.env.DSH_BOOT_MODULE, timeout: 30000
}, async t => {
  const host = await createInitializationNative(process.env.DSH_BOOT_MODULE, { assembleStablePrefix: false })
  t.after(() => host.dispose())
  const opening = await host.open().start(host.input)
  const run = await app(t, base(opening.messages, {
    sessionId: opening.sessionId, macroState: { userName: '旧玩家', local: {}, global: {} }
  }), true, true, {
    planner: createContextPlanner({ prompt: key => key }),
    card: { name: '角色', post_history_instructions: '本轮只使用最新玩家：{{user}}' }
  })
  const adapter = createForegroundFrameSessionAdapter()
  let prepared
  const strategies = createForegroundOrchestrationStrategies({ nativePlay: {
    modeFor: async () => 'story', filterMessages: messages => messages,
    resolvePreset: async () => null, visibleTools: async () => [], controlledToolNames: new Set(),
    async prepareTurn(input) {
      const request = { ...input, requestId: 'native-template' }
      await run.turns.appendUser(request)
      run.beforePatch(() => saveTemplate(run, target, 928))
      prepared = await run.turns.prepare(request)
      return prepared
    },
    appendFrame: input => adapter.append(input), recordFrame() {}
  } })
  // 使用正式装配和 pre-step 钩子，经真实 Agent 循环到达隔离 provider。
  const ctx = { on(name, listener, options) {
    if (name === 'system-prompt/assemble' || name === 'agent/pre-step') return host.ctx.on(name, listener, options)
  } }
  const backgroundAgentRunner = { owns: () => false }
  registerTurnLifecycleHooks({ ctx, foregroundStrategies: strategies, backgroundAgentRunner,
    hookChatForSession: run.stored, foregroundHandoff: { awaitOpening: async () => {} },
    readChatCard: async () => ({}), turnOrchestrator: { modeFor: async () => 'story' },
    ensureNativeSystemPrefix: async () => {}, publishResourceWorkspace: async () => null,
    nativeWorldBookTemplateContext: async () => ({ prefixContext: '' }),
    runtimePrompt: () => '', sessionStore: host.ctx.sessions })
  registerRequestHooks({ ctx, foregroundStrategies: strategies, backgroundAgentRunner,
    chatForSession: run.stored, sessionStore: host.ctx.sessions,
    cardMemory: { appendRecall: ({ decision }) => decision }, requestIdForMessages: () => 'native-template',
    tavernRetryLimiter: { handle() {} } })
  host.target.agent.followup({ id: 'native-template', role: 'user',
    content: [{ type: 'text', text: '继续' }], source: { kind: 'user', rpcId: 'native-template' } })
  await host.target.agent.whenIdle()
  assert.equal(host.requests.length, 1, JSON.stringify(sessionEvents(host.target.session).filter(event => event.type === 'turn/end').map(event => event.data)))
  const actual = JSON.stringify(host.requests[0].messages)
  assert.match(actual, /本轮只使用最新玩家：玩家928/)
  assert.doesNotMatch(actual, /本轮只使用最新玩家：旧玩家/)
  const saved = await run.stored()
  assert.equal(saved.messages.length, 3)
  assert.equal(saved.messages[1].variables[0].stat_data.hp, 928)
  assert.equal(saved.messages[1].tavernPluginData.template_rendered.hash, 'latest-928')
  assert.equal(prepared.frame.source.regenerationMaterials.generationState.messageVariables.stat_data.hp, 928)
  assert.deepEqual(saved.foregroundFrames[prepared.frame.operationId], prepared.frame)
  assert.deepEqual(run.effects, { input: 1, worldbook: 1 })
})
