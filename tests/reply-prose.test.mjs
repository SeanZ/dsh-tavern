import assert from 'node:assert/strict'
import test from 'node:test'

import { projectReplyLayers } from '../tavern-plugin/lib/domain/reply-presentation.js'
import { replyProse, replyProseProblems } from '../tavern-plugin/lib/domain/reply-prose.js'
import { replaceTavernHelperMessages } from '../tavern-plugin/lib/domain/tavern-helper-context.js'

// Strips the status block from the model context only, the way card prompt regex does.
const regexScripts = [{ id: 'status', name: 'status', findRegex: '/<status>[\\s\\S]*?<\\/status>/g', replaceString: '',
  trimStrings: [], placement: [2], enabled: true, markdownOnly: false, promptOnly: true, runOnEdit: false, minDepth: null, maxDepth: null }]

function savedRound(source) {
  const reply = projectReplyLayers(source, { regexScripts, placement: 2, isEdit: false, depth: 0 })
  return { role: 'assistant', turn: 2, ...replyProse(source, reply), swipeId: 0, swipes: [reply.projectionText], variables: [{}] }
}

test('正文字段不变量：一次保存的正文一致，#306 式的单字段改写会被查出', () => {
  const row = savedRound('正文<status>hp=7</status>')
  assert.equal(row.text, '正文')
  assert.deepEqual(replyProseProblems(row, { regexScripts }), [])

  // #306: settlement turned text back into the raw reply.
  assert.deepEqual(replyProseProblems({ ...row, text: row.sourceText }, { regexScripts }), ['text 不是 projectionText 经提示词正则后的结果'])
  assert.deepEqual(replyProseProblems({ ...row, sessionText: row.sourceText }), ['sessionText 与 text 不一致'])
  assert.deepEqual(replyProseProblems({ ...row, projectionText: '别的' }), ['原文没有宏，projectionText 却不同于 sourceText'])
  assert.deepEqual(replyProseProblems({ ...row, swipes: ['别的'] }), ['当前 swipe 既不是 sourceText 也不是 projectionText'])
})

test('Helper 切换或改写 swipe 时，正文按保存时的提示词正则重新投影', () => {
  const row = savedRound('甲<status>hp=7</status>')
  row.swipes.push('乙<status>hp=3</status>')
  row.variables.push({})
  row.sessionText = row.text
  const chat = { cardName: '角色', macroState: {}, messages: [row] }

  replaceTavernHelperMessages(chat, [{ message_id: 0, swipe_id: 1 }], { regexScripts })
  assert.equal(row.text, '乙')
  assert.equal(row.sourceText, '乙<status>hp=3</status>')
  assert.equal(Object.hasOwn(row, 'sessionText'), false)
  assert.deepEqual(replyProseProblems(row, { regexScripts }), [])

  replaceTavernHelperMessages(chat, [{ message_id: 0, message: '丙<status>hp=1</status>' }], { regexScripts })
  assert.equal(row.text, '丙')
  assert.deepEqual(row.swipes, ['甲<status>hp=7</status>', '丙<status>hp=1</status>'])
  assert.deepEqual(replyProseProblems(row, { regexScripts }), [])
})
