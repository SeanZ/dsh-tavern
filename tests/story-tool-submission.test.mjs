import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

import { appendStorySubmissionReminder, createStorySubmissionTool, storySubmissionForTurn } from "../tavern-plugin/lib/domain/story-tool-submission.js"

function fixture(content = '<game>正文\\引号"\n新行</game>', { error = false, result = content, turn = 2 } = {}) {
  const raw = JSON.stringify({ content })
  return { id: 'game', events: [
    { type: 'turn/start', data: { turn } },
    { type: 'assistant/message', data: { turn, message: { id: 'model-1', source: { kind: 'model' }, content: [
      { type: 'reasoning', text: '思考' }, { type: 'text', text: '不应覆盖提交的杂话' },
      { type: 'tool-call', id: 'submit-1', name: 'submit_story', arguments: raw }
    ] } } },
    { type: 'tool/call', data: { turn, callId: 'submit-1', name: 'submit_story', arguments: raw } },
    // 0.2.1 lifts the receipt into a first-class tool message: the call id and the
    // text sit on the message itself, not in a `tool-result` block.
    { type: 'tool/result', data: { turn, message: { role: 'tool', toolCallId: 'submit-1', isError: error, content: [{ type: 'text', text: result }] } } }
  ] }
}

test('工具仅允许已开启的前台 story/script，拒绝空正文、后台、失效宿主和已结束回合', async () => {
  let chat = { mode: 'story' }, enabled = true, background = false, concluded = 0
  const tool = createStorySubmissionTool({ chatForSession: async () => chat, enabled: async () => enabled, isBackground: () => background })
  const session = { id: 'game', events: [{ type: 'turn/start', data: { turn: 1 } }] }
  const exec = { agent: { session }, signal: new AbortController().signal, concludeTurn() { concluded++ } }
  assert.equal(await tool.execute({ content: '正文' }, exec), '正文')
  assert.equal(concluded, 1)
  assert.equal(tool.isConcurrencySafe(), false)
  for (const content of ['', '  ', null, 123]) await assert.rejects(tool.execute({ content }, exec), /正文不能为空/)
  for (chat of [undefined, { mode: 'card' }]) await assert.rejects(tool.execute({ content: '正文' }, exec), /未开启/)
  chat = { mode: 'story' }; enabled = false
  await assert.rejects(tool.execute({ content: '正文' }, exec), /未开启/)
  chat = { mode: 'script' }; enabled = true
  assert.equal(await tool.execute({ content: '剧本正文' }, exec), '剧本正文')
  background = true
  await assert.rejects(tool.execute({ content: '正文' }, exec), /前台游玩/)
  background = false
  await assert.rejects(tool.execute({ content: '正文' }, { ...exec, concludeTurn: undefined }), /DSH 版本/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(tool.execute({ content: '正文' }, { ...exec, signal: controller.signal }), { name: 'AbortError' })
  session.events.push({ type: 'turn/end', data: { turn: 1 } })
  await assert.rejects(tool.execute({ content: '正文' }, exec), /没有正在生成/)
})

test('报错的回执仍不算提交', () => {
  assert.equal(storySubmissionForTurn(fixture('她推开门。', { error: true }), 2), null)
})

test('输出走工具调用时在插件 sections 之后补最后提醒', () => {
  const assembly = { sections: [
    { name: 'tavern:story-tool-submission', text: 'rules' },
    { name: 'plugin:one', text: 'third-party' }
  ] }
  const withReminder = appendStorySubmissionReminder(assembly, true)
  assert.deepEqual(withReminder.sections.map(section => section.name),
    ['tavern:story-tool-submission', 'plugin:one', 'tavern:story-tool-submission-reminder'])
  assert.match(withReminder.sections.at(-1).text, /唯一出口是 submit_story/)
  assert.match(withReminder.sections.at(-1).text, /不要重复上面的确认/)
  assert.equal(appendStorySubmissionReminder(assembly, false), assembly, '输入回放不加提交提醒')
  assert.equal(appendStorySubmissionReminder({ sections: [{ name: 'plugin:one' }] }, true).sections.length, 1,
    '本局关闭提交工具时没有提醒可加')
})

const server = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
const hooks = await readFile(new URL('../tavern-plugin/lib/hooks/turn-lifecycle.js', import.meta.url), 'utf8')
