import assert from 'node:assert/strict'
import test from 'node:test'
import { renderTavernMacros } from '../tavern-plugin/lib/domain/tavern-macro-engine.js'

import { editableReplyParts, projectReplyLayers, projectReplyHistory, resolveDisplayIdentityMacros } from "../tavern-plugin/lib/domain/reply-presentation.js"

function script(name, findRegex, replaceString, flags = {}) {
  return {
    id: name,
    name,
    findRegex,
    replaceString,
    trimStrings: [],
    placement: [2],
    enabled: true,
    markdownOnly: flags.markdownOnly === true,
    promptOnly: flags.promptOnly === true,
    runOnEdit: false,
    minDepth: null,
    maxDepth: null
  }
}

test('显示身份替换与完整宏引擎兼容旧 USER/CHAR/BOT 标记，不执行有状态宏', () => {
  const source = '<user> / <USER> / {{ user }} / <char> / <BOT> / {{char}}'
  const options = { charName: '向导', macroState: { userName: '林舟' } }
  assert.equal(resolveDisplayIdentityMacros(source, options), renderTavernMacros(source, { userName: '林舟', charName: '向导' }).text)
  assert.equal(resolveDisplayIdentityMacros('<user>', {}), '你')
  assert.equal(resolveDisplayIdentityMacros('<char>', {}), '<char>')
  assert.equal(resolveDisplayIdentityMacros('<user>{{incvar::count}}{{setvar::name::x}}', options), '林舟{{incvar::count}}{{setvar::name::x}}')
  assert.equal(resolveDisplayIdentityMacros('<user-card><user data-id="1">正文</user></user-card>', options), '<user-card><user data-id="1">正文</user></user-card>')
})

test('开场历史投影在分段前替换尖括号玩家标记，源文与模型正文保持', () => {
  const source = '你好，<user>。<char>正在等你。'
  const options = { macroState: { userName: '林舟' }, charName: '向导' }
  const message = { role: 'assistant', greeting: true, turn: 1, text: source, sourceText: source }
  const original = structuredClone(message)
  const projected = projectReplyHistory([message], options)
  assert.deepEqual(projected.projections[0].parts, [{ kind: 'markdown', text: '你好，林舟。向导正在等你。' }])
  assert.deepEqual(message, original)
  const layers = projectReplyLayers(source, options)
  assert.equal(layers.sourceText, source)
  assert.equal(layers.sessionText, source)
})

test('正则引入的旧身份标记与 HTML 属性都在共同展示层解析', () => {
  const result = projectReplyLayers('开场', {
    macroState: { userName: '林舟' }, charName: '向导', placement: 2,
    regexScripts: [script('玩家面板', '开场', '<div title="<USER>"><user>，<bot>欢迎你。</div>', { markdownOnly: true })]
  })
  assert.deepEqual(result.displayParts, [{ kind: 'html', content: '<div title="林舟">林舟，向导欢迎你。</div>' }])
  assert.equal(result.sessionText, '开场')
})

test('新局尚无玩家消息：原生开场已替换，模板格式化正文中的旧标记也必须替换', () => {
  const source = '你好，<user>。'
  const message = {
    role: 'assistant', greeting: true, turn: 1, swipeId: 0,
    sourceText: source, projectionText: '你好，林舟。', text: '你好，林舟。',
    tavernPluginData: { template_display: { source, swipe: 0,
      formattingText: source + '\n\n<div>状态：平静</div>',
      html: '<p>' + source + '</p><div>状态：平静</div>' } }
  }
  const original = structuredClone(message)
  const result = projectReplyHistory([message], { macroState: { userName: '林舟' } })
  assert.equal(result.projections.length, 1)
  assert.equal(result.projections[0].turn, 1)
  assert.deepEqual(result.projections[0].parts, [
    { kind: 'markdown', text: '你好，林舟。\n\n' },
    { kind: 'html', content: '<div>状态：平静</div>' }
  ])
  assert.deepEqual(message, original, '不修改原文、原生正文或持久化模板')
})

test('损坏规则只产生目标诊断，后续规则继续执行', () => {
  const result = projectReplyLayers('进入校园', {
    regexScripts: [
      script('损坏规则', '/[/', '坏'),
      script('可用规则', '校园', '学院')
    ],
    placement: 2
  })

  assert.equal(result.sessionText, '进入学院')
  assert.equal(result.displayText, '进入学院')
  assert.match(result.warnings.join('\n'), /Session：损坏规则/)
  assert.match(result.warnings.join('\n'), /展示：损坏规则/)
})

for (const block of [
  '<UpdateVariable>secret</UpdateVariable>',
  '<INITVAR>secret\r\nsecond</INITVAR>',
  '<initvar format="yaml">secret</initvar>',
  '<UpdateVariable><initvar>secret</initvar></UpdateVariable>',
  '<initvar><initvar>secret</initvar>secret</initvar>',
  '<Variables>{"version":1}</Variables>',
  '<update_variable>{"op":"replace"}</update_variable>',
  '<jsonpatch>[{"op":"replace"}]</jsonpatch>',
  '<mvu_update>{"hp":1}</mvu_update>',
  '<story_choices>{"actors":[{"name":"我","actions":["a"]}],"event":"e","scene":"s"}</story_choices>',
  '<ta_hub>{"version":1,"source":"preset fallback"}</ta_hub>'
]) test('变量控制块不作为正文展示：' + block.split('>')[0], () => {
  const source = '之前\r\n' + block + '\r\n之后'
  const result = projectReplyLayers(source)
  assert.equal(result.sourceText, source)
  assert.equal(result.sessionText, source)
  assert.deepEqual(result.displayParts, [{ kind: 'markdown', text: '之前\r\n' }, { kind: 'markdown', text: '\r\n之后' }])
  assert.equal(editableReplyParts(source).map(part => part.text).join(''), source)
})

// 剥离标记块的正则吃掉 `</thinking>` 之后，整条回复曾被当作未闭合的隐藏协议连正文一起吞掉。
test('未闭合的思考标签只隐藏标签本身，正文照常显示', () => {
  const source = '\n<thinking>\n规划：先置入三个标记块再衔接正文\n客厅里死寂得只剩下布料摩挲的细碎声响。\n'
  const result = projectReplyLayers(source)
  assert.equal(result.sourceText, source)
  const shown = result.displayParts.map(part => part.text || part.content || '').join('')
  assert.match(shown, /客厅里死寂/)
  assert.ok(!shown.includes('<thinking>'))
})
