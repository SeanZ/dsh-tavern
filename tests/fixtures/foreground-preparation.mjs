import { diffJson } from '../../tavern-plugin/lib/domain/json-mutation.js'
import assert from 'node:assert/strict'
import { projectFullPromptTemplateState } from '../../tavern-plugin/lib/domain/full-prompt-template-state.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createChatJournalStore } from '../../tavern-plugin/lib/domain/chat-journal-store.js'
import { createChatPersistence } from '../../tavern-plugin/lib/domain/chat-persistence.js'
import { createSessionSliceReader } from '../../tavern-plugin/lib/domain/session-view-reader.js'
import { createBoundedHistory } from '../../tavern-plugin/lib/domain/bounded-history.js'
import { createTurnOrchestrator } from '../../tavern-plugin/lib/domain/turn-orchestration.js'
import { createStoryTimeline } from '../../tavern-plugin/lib/domain/story-timeline.js'
import { createForegroundFrameBuilder } from '../../tavern-plugin/lib/domain/agent-input-frame.js'
import { createTavernScriptHostAdapter } from '../../tavern-plugin/lib/domain/tavern-script-host-adapter.js'

export function history(count, variablesAt) {
  const messages = []
  for (let turn = 1; turn <= count; turn++) {
    messages.push({ role: 'user', text: '行动 ' + turn, turn })
    messages.push({ role: 'assistant', text: '正文 ' + turn, turn, swipeId: 0, swipes: ['正文 ' + turn],
      ...(variablesAt(turn) ? { variables: [{ stat_data: { hp: turn }, schema: {} }] } : {}) })
  }
  return messages
}

// Two identical chats: one commits through the append patch, the other through
// the complete-chat update. Every stored field except timestamps must agree.
export async function app(t, chat, scoped, template = false, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'foreground-append-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let clock = 1000, ids = 0, planCalls = 0
  const persistence = createChatPersistence({ store: createChatJournalStore({ dataRoot: root, newConversations: true }), now: () => clock })
  await persistence.write(structuredClone(chat), { source: 'chat.create' })
  const calls = { full: 0, update: 0, patch: 0 }
  const effects = { input: 0, worldbook: 0 }
  let duringWorldbook = null
  let beforePlan = null
  let beforePatch = null
  let beforeHelperPatch = null
  const store = {
    async chatForSession() { calls.full++; return persistence.read(chat.id) },
    readCard: async () => options.card || ({ name: 'Card' }),
    writeChat: persistence.write,
    writeChatHeader: persistence.writeHeader,
    async updateChat(...args) { calls.update++; return persistence.update(...args) },
    ...(scoped ? {
      async storyContextForSession(sessionId) {
        const bounded = createBoundedHistory({ links: async () => ({ [chat.sessionId]: chat.id }), readWindow: persistence.readWindow, pageSize: 8 })
        return (await bounded.forSession(sessionId, { storyRows: 3, lastAssistant: true, lastVariables: true })).chat
      },
      readChatSlice: createSessionSliceReader({ links: async () => ({ [chat.sessionId]: chat.id }), readSlice: persistence.readSlice }),
      readChangedSlice: persistence.readChangedSlice,
      readWindow: persistence.readWindow,
      async patchChat(...args) { calls.patch++; const hook = beforePatch; beforePatch = null; await hook?.(); return persistence.patch(...args) }
    } : {})
  }
  const turns = createTurnOrchestrator({
    store, now: () => clock,
    timeline: createStoryTimeline({ id: prefix => prefix + '-' + (++ids), now: () => clock }), frameBuilder: createForegroundFrameBuilder(),
    planner: { plan: async input => {
      planCalls++
      const hook = beforePlan
      beforePlan = null
      await hook?.()
      return options.planner ? options.planner.plan(input) : { text: 'context', systemPromptText: '' }
    } },
    projectReply: text => ({ sourceText: text, projectionText: text, sessionText: text, displayText: text, warnings: [] }),
    ...(template ? {
      projectForegroundWorldbook: async () => { effects.worldbook++; await duringWorldbook?.(); return { context: '' } },
      projectUserTemplate: async ({ text, turn }) => { effects.input++; return { message: { role: 'user', text, tavernPluginData: { rendered: turn },
        variables: [{ stat_data: { hp: -turn }, schema: {} }] }, scopes: { local: { turn }, initial: {} } } }
    } : {})
  })
  const helper = createTavernScriptHostAdapter({
    resolveChat: store.chatForSession, resolveChatSlice: store.readChatSlice, readChatRevision: persistence.readRevision,
    async patchChat(...args) {
      const hook = beforeHelperPatch
      beforeHelperPatch = null
      await hook?.()
      return persistence.patch(...args)
    },
    updateChat: persistence.update, writeChat: store.writeChat, readCard: store.readCard, worldBooks: {}, scriptDispatch: {}
  })
  async function play(turn, userText = '继续') {
    clock += 10
    await turns.prepare({ sessionId: chat.sessionId, turn, userText })
    calls.full = 0
    clock += 10
    return turns.finalize({ sessionId: chat.sessionId, turn, userText, assistantText: '回复 ' + turn })
  }
  return { persistence, turns, calls, effects, get planCalls() { return planCalls }, play, helper, stored: () => persistence.read(chat.id),
    duringWorldbook: fn => { duringWorldbook = fn }, beforePlan: fn => { beforePlan = fn },
    beforePatch: fn => { beforePatch = fn }, beforeHelperPatch: fn => { beforeHelperPatch = fn } }
}

export function base(messages, extra = {}) {
  return { id: 'chat-1', sessionId: 's', mode: 'story', cardPath: 'cards/a.json', backgroundConfigVersion: 1, conversationFeaturesVersion: 1,
    mvu: { enabled: true, owner: 'official' }, messages, ...extra }
}

export async function saveTemplate(run, target, hp, patch = true) {
  const request = projectFullPromptTemplateState(await run.stored())
  const baseline = structuredClone(request)
  const row = request.chat[target === 'staged' ? request.chat.length - 1 : Number.isInteger(target) ? target : 24]
  row.variables = [{ stat_data: { hp }, schema: {} }]
  row.variables_initialized = true
  row.is_ejs_processed = [true]
  row.template_rendered = { hash: 'latest-' + hp, swipe: 0 }
  row.template_display = { source: row.mes, swipe: 0, text: '显示-' + hp }
  request.chat_metadata.variables.latestTemplate = hp
  const result = await run.helper.saveFullPromptTemplateState(request.sessionId, patch ? {
    chatId: request.chatId, sessionId: request.sessionId, stateRevision: request.stateRevision,
    lifecycleRevision: request.lifecycleRevision, changes: diffJson(baseline, request)
  } : request)
  assert.equal(result.updated, true)
  if (patch) assert.ok(Array.isArray(result.statePatch), '正式模板增量保存路径已执行')
  await run.helper.updateVariables(request.sessionId, { type: 'chat' }, { ...request.chat_metadata.variables, playerName: '玩家' + hp }, 0)
}

