import assert from 'node:assert/strict'
import test from 'node:test'
import { createServerTemplateFixture } from './fixtures/server-template-runtime.mjs'
import { invalidateOrdinaryDisplayCache } from '../tavern-plugin/lib/domain/ordinary-display-cache.js'

test('普通格式缓存失效后重新同步不重放模板，真实 EJS 展示仍保留当时值', async t => {
  const runtime = createServerTemplateFixture()
  t.after(() => runtime.dispose())
  const context = { globalVariables: { hp: 7 },
    settings: { preload_worldinfo_enabled: false, raw_message_evaluation_enabled: false },
    regexScripts: [{ id: 'format', name: '纯格式', findRegex: '/普通正文/g', replaceString: '**普通正文**', placement: [2], markdownOnly: true }],
    transcript: [{ role: 'assistant', content: '普通正文' }, { role: 'assistant', content: '当时值 <%= getGlobalVar("hp") %>' }] }
  const initial = (await runtime.lifecycle(context)).first.chat
  assert.equal(typeof initial[0].template_display?.formattingText, 'string')
  const adapted = { messages: initial.map(row => ({ tavernPluginData: { template_display: row.template_display } })) }
  assert.equal(invalidateOrdinaryDisplayCache(adapted), 1)
  const transcript = initial.map((row, i) => ({ ...row, role: 'assistant', content: row.mes,
    template_display: adapted.messages[i].tavernPluginData.template_display }))
  const reopened = await runtime.lifecycle({ ...context, globalVariables: { hp: 99 }, regexScripts: [], transcript })
  assert.equal(reopened.first.chat[0].template_display, undefined)
  assert.deepEqual(reopened.first.chat[0].template_rendered, initial[0].template_rendered)
  assert.deepEqual(reopened.first.chat[1].template_display, initial[1].template_display)
  assert.deepEqual(reopened.second.chat, reopened.first.chat)
})
