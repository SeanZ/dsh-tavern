import { createBackgroundAgentRunner } from '../../tavern-plugin/lib/background-agent-runner.js'
import { stagePages } from '../../tavern-plugin/lib/domain/stage-performance.js'
import { createStageDirector } from '../../tavern-plugin/lib/domain/stage-director.js'
import { createPluginData } from '../../tavern-plugin/lib/domain/plugin-data.js'
import { createChatPersistence } from '../../tavern-plugin/lib/domain/chat-persistence.js'
import { computeSceneTarget } from '../../tavern-plugin/lib/domain/scene-illustration.js'
import { stageDirectorCommit } from '../../tavern-plugin/lib/stage-director-commit.js'

// The real transaction/record adapters with an isolated serial JSON store.
export async function stageDirectorFixture(chat, assets, options = {}) {
  const files = new Map([['chats/' + chat.id + '.json', structuredClone(chat)]])
  let tail = Promise.resolve(), writes = 0, published = 0
  const store = {
    readJson: async path => structuredClone(files.get(path)),
    updateJson(path, change) {
      const result = tail.then(async () => {
        const value = await change(structuredClone(files.get(path)))
        if (value !== undefined) { files.set(path, structuredClone(value)); writes++ }
        return structuredClone(files.get(path))
      })
      tail = result.catch(() => {})
      return result
    },
    remove: async path => { files.delete(path) }
  }
  // Separate serialized stores: a stage write occurs while the story lock is held.
  const dataFiles = new Map()
  const data = createPluginData({ store: {
    readJson: async path => structuredClone(dataFiles.get(path)),
    updateJson: async (path, change) => { const next = change(structuredClone(dataFiles.get(path))); dataFiles.set(path, next); return next }
  } })
  const persistence = createChatPersistence({ data: store })
  const read = () => persistence.read(chat.id)
  const turns = {
    resolveGame: async sessionId => sessionId === chat.sessionId ? { chatId: chat.id, sessionId } : null,
    currentKeys: async (_sessionId, numbers) => {
      const current = await read()
      return new Map(numbers.map(turn => { try { return [turn, computeSceneTarget(current, turn).key] } catch { return [turn, null] } }))
    },
    readPendingTurn: async () => {
      const current = await read(), last = current.messages.filter(item => item.role === 'assistant').at(-1)
      const turn = last.turn || 1
      return { chatId: chat.id, sessionId: chat.sessionId, turn, key: computeSceneTarget(current, turn).key, text: last.text }
    }
  }
  let enabled = true
  const make = (overrides = {}) => createStageDirector({ turns, data, enabled: async () => enabled, catalog: async () => assets,
    binding: async () => (await read()).timeline, commit: stageDirectorCommit(persistence), publish: () => { published++ }, selection: async () => ({provider:'fixture', model:'fixture'}), ...options, ...overrides })
  const director = make()
  const prepare = async () => {
    const request = await director.prepare(await turns.readPendingTurn())
    return request && { ...request, call: (args, signal) => request.call(args && typeof args === 'object' && !Array.isArray(args) ? { ...request.seal, ...args } : args, signal) }
  }
  return { director, data, persistence, read, make, prepare, assets, body: turns.readPendingTurn, enabled: value => { enabled = value }, stats: () => ({ writes, published }) }
}

// A native runner with a synthetic model adapter: separate session, real tool dispatch.
export async function runDirectorFixture(fixture, submissions) {
  const receipts = [], sessions = [], prompts = []
  const seal = { sequence: 1, through: stagePages((await fixture.body()).text).length, done: true }
  const runner = createBackgroundAgentRunner({ id: () => 'director-fixture', backgroundTools: [{name:'posture_submit'}],
    resolveStablePrefix: () => { throw Error('Director must not inherit settlement context') },
    resolveCurrentWorldbook: () => { throw Error('Director must not inherit live worldbook context') },
    agents: { get: () => ({id:'foreground', session:{header:{}}}), async create(options) {
      const tools = new Map(), sections = []
      await options.setup({systemPrompt:{section(value) {sections.push(value)}, suppressRuntimeContext() {}}, on() {},
        tools:{restrict() {}, register(tool) {tools.set(tool.name,tool); return () => tools.delete(tool.name)}}})
      const session = {id:options.sessionId, events:[], append(type,data) {this.events.push({type,data})}}
      sessions.push(session.id)
      let work
      return {agent:{session, followup(message) { prompts.push({system:sections.map(item=>item.text()).join('\n'), text:message.content[0].text})
        work = (async () => {
          if (tools.size !== 1 || !tools.has('stage_update')) throw Error('Only the director tool may be exposed')
          for (const delta of submissions) receipts.push(JSON.parse(await tools.get('stage_update').execute({ ...seal, ...delta })))
          session.append('assistant/message',{message:{content:[{type:'text',text:'Done.'}]}})
        })()
      }, async whenIdle() {await work}}, async dispose() {}}
    } } })
  try { await fixture.make({runAgent: input => runner.run(input)}).run(await fixture.body()) }
  finally { await runner.dispose() }
  return {receipts, sessions, prompts}
}
