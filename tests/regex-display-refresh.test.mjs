import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { invalidateOrdinaryDisplayCache } from '../tavern-plugin/lib/domain/ordinary-display-cache.js'
import { createReplyHistoryProjector, projectReplyLayers } from '../tavern-plugin/lib/domain/reply-presentation.js'
import { createRegexManager } from '../tavern-plugin/lib/domain/regex-manager.js'
import { createChatPersistence } from '../tavern-plugin/lib/domain/chat-persistence.js'
import { createChatJournalStore } from '../tavern-plugin/lib/domain/chat-journal-store.js'

const numericPattern = '/（第[0-9０-９零〇一二三四五六七八九十百千万两]+楼）/g'
const rule = { id: 'floor-label', name: '楼层标记', findRegex: '/（第.*?楼）/gs',
  replaceString: '', placement: [2], markdownOnly: true, enabled: true }
const source = '<!-- 检查（第一阶段） -->\n**普通正文**\n<!-- 完成（第76楼） -->'
function message(turn, text = source) {
  return { id: 'm-' + turn, role: 'assistant', turn, sourceText: text, text,
    swipeId: 0, swipes: [text], variables: [{ hp: 10 }],
    tavernPluginData: { template_rendered: { hash: 'done', swipe: 0 },
      template_display: { source: text, swipe: 0, html: '<!-- 坏缓存 -->',
        formattingText: projectReplyLayers(text, { regexScripts: [rule] }).displayText } } }
}

test('数字楼层规则不跨行、不吞普通括号，仍支持三种数字', () => {
  const fixed = { ...rule, findRegex: numericPattern }
  const project = text => projectReplyLayers(text, { regexScripts: [fixed] })
  assert.equal(project(source).displayText, '<!-- 检查（第一阶段） -->\n**普通正文**\n<!-- 完成 -->')
  for (const text of ['（第76楼）', '（第７６楼）', '（第七十六楼）']) assert.equal(project(text).displayText, '')
  for (const text of ['（第一阶段）\n正文\n（顶楼）', '（第76\n楼）', '（第一段普通文字楼）']) {
    assert.equal(project(text).displayText, text)
    assert.equal(project(text).sessionText, text, '仅显示规则不改变模型正文')
  }
})

test('历史投影逐消息执行正则：跨消息起止符不匹配，单消息多行 HTML 规则照常生效', () => {
  const inputs = ['（第一层正文', '第二层正文楼）']
  const messages = inputs.map((text, i) => ({ role: 'assistant', turn: i + 1, sourceText: text, text }))
  const before = structuredClone(messages)
  assert.deepEqual(createReplyHistoryProjector()(messages, { regexScripts: [rule] }).projections.map(p => p.text), inputs)
  assert.deepEqual(messages, before)
  const htmlRule = { ...rule, findRegex: '/<panel>([\\s\\S]*?)<\\/panel>/g', replaceString: '<details>$1</details>' }
  assert.equal(projectReplyLayers('<panel>第一行\n第二行</panel>', { regexScripts: [htmlRule] }).displayText,
    '<details>第一行\n第二行</details>')
})

test('普通缓存失效保留源文、候选、变量、真实 EJS 输出和处理标记；重复失效幂等', () => {
  const ordinary = message(1)
  const template = message(2, '模板源文')
  template.tavernPluginData.template_display = { source: template.sourceText, swipe: 0, html: '<div class="ejs">模板结果</div>' }
  const chat = { messages: [ordinary, template] }, before = structuredClone(chat)
  assert.equal(invalidateOrdinaryDisplayCache(chat), 1)
  delete before.messages[0].tavernPluginData.template_display
  assert.deepEqual(chat, before)
  assert.equal(invalidateOrdinaryDisplayCache(chat), 0)
  const projections = createReplyHistoryProjector()(chat.messages, { regexScripts: [{ ...rule, findRegex: numericPattern }] }).projections
  assert.match(projections[0].text, /普通正文/)
  assert.equal(projections[1].text, '<div class="ejs">模板结果</div>')
})

test('真实存储：覆盖变更在最新版本内清缓存，并发追加不丢失；不变的覆盖不清缓存', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-regex-refresh-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const open = () => createChatPersistence({ store: createChatJournalStore({ dataRoot: root }) })
  const persistence = open()
  await persistence.write({ id: 'chat-1', sessionId: 'session-1', mode: 'story',
    runtimePresetSnapshot: { regexScripts: [rule] }, messages: [message(1)], variables: { turn: 1 } })
  let notifications = 0, append = true
  const manager = createRegexManager({
    chatForSession: async () => {
      const snapshot = await persistence.read('chat-1')
      if (append) {
        append = false
        await persistence.update('chat-1', chat => { chat.messages.push(message(2, '新回复')); return chat })
      }
      return snapshot
    },
    groupOfMode: () => 'play',
    updateChat: persistence.update,
    onOverridesChanged: async () => { notifications++ }
  })
  await manager.setOverride({ sessionId: 'session-1', source: 'preset', key: rule.id, enabled: false })
  const saved = await open().read('chat-1')
  assert.equal(saved.messages.length, 2)
  assert.deepEqual(saved.messages.map(m => m.sourceText), [source, '新回复'])
  assert.ok(saved.messages.every(m => !m.tavernPluginData.template_display))
  assert.ok(saved.messages.every(m => m.tavernPluginData.template_rendered.hash === 'done'))
  assert.deepEqual(saved.variables, { turn: 1 })
  assert.equal(notifications, 1)
  await persistence.update('chat-1', chat => { chat.messages[1] = message(2, '已刷新'); return chat })
  await manager.setOverride({ sessionId: 'session-1', source: 'preset', key: rule.id, enabled: false })
  assert.ok((await open().read('chat-1')).messages[1].tavernPluginData.template_display)
  assert.equal(notifications, 1)
})
