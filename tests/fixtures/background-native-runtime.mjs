import { createBackgroundSessionRetirement, installRetiredBackgroundFilter } from '../../tavern-plugin/lib/domain/background-session-retirement.js'
// Real installed DSH Agent loop/tools/sessions with a scripted text model, for background agents.
import { sessionEvents } from '../../tavern-plugin/lib/domain/session-events.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBackgroundAgentRunner } from '../../tavern-plugin/lib/background-agent-runner.js'
import { createProfileDataStore } from '../../tavern-plugin/lib/profile-data-store.js'

export async function createBackgroundNativeRuntime(bootPath, { systemAppend, resolveModelSelection, beforeModelRequest, residentOptions = {}, setupHost, fileTools = true } = {}) {
  const bootUrl = pathToFileURL(bootPath)
  const { boot } = await import(bootUrl.href)
  const { LlmAdapter } = await import(new URL('../../dsh-llm/lib/index.js', bootUrl))
  const root = await mkdtemp(join(tmpdir(), 'tavern-background-native-'))
  const config = join(root, 'host.yml')
  const packages = ['dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-session-query', 'dsh-subagent', 'dsh-session-persistence-jsonl', 'dsh-token-meter', 'dsh-agent-loop', 'dsh-attachment-local', 'dsh-fs-local', 'dsh-working-directory', 'dsh-tool-fs', 'dsh-tool-executor-native']
  await writeFile(config, packages.filter(name => fileTools || name !== 'dsh-tool-fs').map(name => '- id: ' + name + '\n  name: ' + new URL('../../' + name + '/lib/index.js', bootUrl).href + (name === 'dsh-attachment-local' ? '\n  config:\n    dshHome: ' + root : name === 'dsh-tool-fs' && typeof fileTools === 'object' ? '\n  config: ' + JSON.stringify(fileTools) : name === 'dsh-session-persistence-jsonl' ? '\n  config:\n    root: ' + join(root, 'sessions') + '\n    compression: none' : '') + '\n').join(''))
  const ctx = await boot('background-native-test', config)
  ctx.baseUrl = bootUrl.href
  const disposeHost = await setupHost?.(ctx)
  const requests = []
  class FixtureModel extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }] } }
    }
    async *stream(input) {
      await beforeModelRequest?.(input)
      requests.push(structuredClone({ model: input.model, reasoningEffort: input.reasoningEffort, maxTokens: input.maxTokens, system: input.messages.filter(message => message.role === 'system').flatMap(message => message.content || []), messages: input.messages, tools: input.tools }))
      const block = { type: 'text', text: '已完成。' }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['scene-fixture', 'scene-fixture-other', 'deepseek-official'], new FixtureModel())
  for (const name of ['skill', 'tavern_read_skill_reference', 'web_search']) ctx.tools.register({
    name, description: 'Fixture tool', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'fixture' }
  })
  const parent = await ctx.agents.create({ sessionId: 'scene-parent', agentOptions: { provider: 'scene-fixture', model: 'fixture-text' } })
  const retirement = createBackgroundSessionRetirement(createProfileDataStore({ dataRoot: root }), { isRunning: id => ctx.agents.get(id)?.status === 'running' })
  const stopRetirementFilter = installRetiredBackgroundFilter(ctx.get('subagents'), retirement, ctx.get('sessionQuery'))
  const runnerOptions = { retirement, ...residentOptions, systemAppend, resolveModelSelection, agents: ctx.agents, flushSession: session => ctx.sessions.flush(session) }
  let runner = createBackgroundAgentRunner(runnerOptions)
  // The runner's idle timers are unref'd: keep the loop alive while a test waits on a stalled model.
  const keepAlive = setInterval(() => {}, 1000)
  return {
    requests,
    runBackground: input => runner.run(input),
    backgroundChildren: async () => await ctx.get('subagents').listChildren('scene-parent'),
    reapBackground: () => runner.reapIdle(),
    backgroundLoaded: id => ({ agent: !!ctx.agents.get(id), session: !!ctx.sessions.get(id) }),
    traceEvents(sessionId) { return structuredClone(sessionEvents(ctx.sessions.get(sessionId))) },
    async restart() { await runner.dispose(); runner = createBackgroundAgentRunner(runnerOptions) },
    async dispose() { clearInterval(keepAlive); stopRetirementFilter(); await runner.dispose(); await parent.dispose(); await ctx.fiber.dispose(); await disposeHost?.(); await rm(root, { recursive: true, force: true }) }
  }
}
