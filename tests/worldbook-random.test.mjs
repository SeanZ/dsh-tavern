import test from 'node:test'
import assert from 'node:assert/strict'
import { createForegroundWorldbook } from '../tavern-plugin/lib/domain/foreground-worldbook.js'
import { projectWorldBookTemplates } from '../tavern-plugin/lib/domain/worldbook-recall.js'

import { UpstreamTemplateRuntime } from './fixtures/upstream-template-runtime.mjs'

const runtime = await UpstreamTemplateRuntime.create()
test('固定前缀稳定，随机运行时条目保留执行；同轮复用、新轮刷新', async () => {
  const entries = [
    { ref: 'fixed', constant: true, content: '固定规则', position: 4, depth: 2, order: 5 },
    { ref: 'open', constant: true, content: '<角色库>', position: 4, depth: 2, order: 10 },
    { ref: 'pool', constant: true, content: '<%= Math.random() %> {{roll 1d20}} {{random::甲,乙}}', position: 4, depth: 2, order: 20 },
    { ref: 'close', constant: true, content: '</角色库>', position: 4, depth: 2, order: 30 }
  ].map(e => ({ enabled: true, ...e }))
  const worldBook = { view: { entries } }
  const project = createForegroundWorldbook({ bound: async () => worldBook, runtime: async () => runtime, globalVariables: async () => ({}) })
  const chat = { messages: [{ role: 'assistant', greeting: true, turn: 1, text: '开场' }] }
  const a = await project({ chat, card: {}, userText: '继续' })
  assert.equal(a.error, null)
  assert.equal(a.prefixContext, '固定规则\n\n<角色库>\n\n</角色库>')
  assert.equal(a.context, a.virtualState.entries.pool.text)
  assert.match(a.virtualState.entries.pool.text, /^0\.\d+ \d+ [甲乙]$/)
  assert.deepEqual(a.refs, [])
  chat.worldBookRandomState = a.randomState
  const repeat = await project({ chat, card: {}, userText: '继续' })
  assert.equal(repeat.context, a.context)
  const background = await projectWorldBookTemplates({ worldBook, runtime, includeConstants: true, chat, card: {}, randomSeed: 'different-background-seed', randomOutputs: a.randomState.outputs })
  assert.match(background.foregroundContext, /<角色库>/)
  assert.ok(background.foregroundContext.includes(a.virtualState.entries.pool.text))
  chat.messages.push({ role: 'assistant', turn: 2, text: '正文' })
  const b = await project({ chat, card: {}, userText: '继续' })
  assert.equal(b.prefixContext, a.prefixContext)
  assert.notEqual(b.context, a.context)
  assert.notEqual(b.virtualState.entries.pool.text, a.virtualState.entries.pool.text)
})
