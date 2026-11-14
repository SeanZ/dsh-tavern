import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const load = (pkg, file) => import(new URL('./types/client/' + file, pathToFileURL(require.resolve(pkg + '/client'))))
const conversation = '@deepseek-ai/dsh-client-ui-conversation'
const { ConversationNodeAssembler } = await load(conversation, 'conversation/assembler.js')
const { ConversationEventRegistry } = await load(conversation, 'conversation/event-registry.js')
const { ConversationViewRegistry } = await load(conversation, 'conversation/view-registry.js')
const { ConversationGroupRegistry } = await load(conversation, 'conversation/group-registry.js')
const { registerConversationNodes } = await load('@deepseek-ai/dsh-client-ui-chat', 'conversation-nodes/register.js')
const contracts = { ...await load(conversation, 'contract/system-prompt.js'), ...await load(conversation, 'contract/request-inspection.js') }
const patch = await readFile(new URL('../tavern-plugin/src/client/modules/assistant-replacement.js', import.meta.url), 'utf8')
const visibility = await readFile(new URL('../tavern-plugin/src/client/modules/assistant-visibility.js', import.meta.url), 'utf8')
vm.runInNewContext(patch + visibility + ';installTavernAssistantVisibilityPatch(require)', {
  require: () => ({ ConversationNodeAssembler, ConversationEventRegistry }), console
})
function assembler() {
  const ctx = { effect: fn => fn() }
  ctx.uiConversation = { events: new ConversationEventRegistry(ctx), views: new ConversationViewRegistry(ctx), ...contracts }
  ctx.uiConversation.groups = new ConversationGroupRegistry(ctx, ctx.uiConversation.views)
  registerConversationNodes(ctx)
  return new ConversationNodeAssembler(ctx.uiConversation.events, ctx.uiConversation.views, ctx.uiConversation.groups)
}
function fixture() {
  const rows = []
  const add = (type, seq, data, surfaceOp) => rows.push({ event: { type, seq, time: seq, data, ...(surfaceOp ? { surfaceOp } : {}) } })
  const message = (seq, turn, text, replace) => add('assistant/message', seq, { turn, step: 1, stream: [],
    message: { id: text === 'seed' ? 'tavern-seed-trajectory:v1:synthetic:2' : 'tavern-opening:synthetic', role: 'assistant',
      content: [{ type: 'text', text }], source: { kind: 'model', provider: 'dsh-tavern', model: 'character-card' } } },
  replace ? { op: 'replace', startSeq: replace, endSeq: replace } : 'append')
  add('turn/start', 3, { turn: 1 }); add('step/start', 4, { turn: 1, step: 1 })
  message(8, 1, 'seed'); message(10, 1, '开场甲')
  add('step/end', 11, { turn: 1, step: 1 }); add('turn/end', 12, { turn: 1, reason: { kind: 'completed' } })
  for (const [turn, start, seq, prior, text] of [[2, 15, 18, 10, '开场乙'], [3, 21, 23, 18, '开场丙']]) {
    add('turn/start', start, { turn }); add('step/start', start + 1, { turn, step: 1 }); message(seq, turn, text, prior)
    add('step/end', seq + 1, { turn, step: 1 }); add('turn/end', seq + 2, { turn, reason: { kind: 'completed' } })
  }
  return rows
}
const visible = a => a.get('chat').nodes.values().filter(n => n.kind === 'assistant-step' && n.visibility === 'visible')
  .map(n => n.data.blocks.map(b => b.text || '').join(''))

test('当前窗口省略已被替换的开场时仍显示最新正文，种子保持隐藏', () => {
  const a = assembler(), rows = fixture().filter(x => ![10, 18].includes(x.event.seq)), before = structuredClone(rows)
  a.replaceWindow(rows, false); a.activateTarget('chat'); a.flush()
  assert.deepEqual(visible(a), ['开场丙'])
  assert.deepEqual(rows, before)
  assert.deepEqual(a.inputs.get(23).event.surfaceOp, { op: 'replace', startSeq: 18, endSeq: 18 })
})

test('连续切换的实时事件与冷重放一致，已替换正文不重复显示', () => {
  const a = assembler(), rows = fixture(), before = structuredClone(rows)
  a.replaceWindow([], false); a.activateTarget('chat')
  for (const row of rows) { a.append(row); a.flush() }
  assert.deepEqual(visible(a), ['开场丙'])
  a.replaceWindow(rows, false); a.flush()
  assert.deepEqual(visible(a), ['开场丙'])
  assert.deepEqual(rows, before)
})

test('普通助手消息保持原生显示，重复安装不会叠加包装', () => {
  const original = ConversationNodeAssembler.prototype.append
  vm.runInNewContext(patch + ';installTavernAssistantReplacementPatch(conversation)', {
    conversation: { ConversationNodeAssembler, ConversationEventRegistry }
  })
  assert.equal(ConversationNodeAssembler.prototype.append, original)
  const a = assembler()
  a.replaceWindow(fixture().filter(x => x.event.seq <= 12), false); a.activateTarget('chat'); a.flush()
  assert.deepEqual(visible(a), ['开场甲'])
})

test('首轮正文同一步的替换能更新内容，原始来源与替换范围保留', () => {
  const a = assembler(), rows = fixture().filter(x => x.event.seq <= 12)
  const original = rows.find(x => x.event.seq === 10)
  const changed = structuredClone(original)
  changed.event.seq = 13
  changed.event.surfaceOp = { op: 'replace', startSeq: 10, endSeq: 10 }
  changed.event.sourceEventSeqs = [10]
  changed.event.data.message.id = 'reply-projection:synthetic'
  changed.event.data.message.content[0].text = '结算后的首轮正文'
  a.replaceWindow(rows, false); a.activateTarget('chat'); a.flush()
  a.append(changed); a.flush()
  assert.deepEqual(visible(a), ['结算后的首轮正文'])
  assert.deepEqual(a.inputs.get(13), changed)
})

test('故事页完成切换后再打开 Chat，分页补入旧事件也只显示当前开场', () => {
  const a = assembler(), rows = fixture()
  a.replaceWindow(rows.filter(row => row.event.seq >= 21), true)
  a.activateTarget('chat'); a.flush()
  assert.deepEqual(visible(a), ['开场丙'])
  a.prepend(rows.filter(row => row.event.seq < 21)); a.flush()
  assert.deepEqual(visible(a), ['开场丙'])
  const b = assembler()
  b.replaceWindow([], false)
  for (const row of rows) b.append(row)
  b.activateTarget('chat'); b.flush()
  assert.deepEqual(visible(b), ['开场丙'])
})
