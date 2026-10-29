import test from 'node:test'
import assert from 'node:assert/strict'
import { createPromptCatalog } from '../tavern-plugin/lib/prompt-catalog.js'

test('默认提示词复用文件内容，但版本变化、空内容和读取失败仍可见', () => {
  let stamp = 1, text = '默认正文', reads = 0
  const prompt = createPromptCatalog(undefined, { version: () => stamp, read: () => { reads++; return text } })
  assert.equal(prompt('story'), text)
  assert.equal(prompt('story'), text)
  assert.equal(reads, 1)
  stamp++; text = '新正文'
  assert.equal(prompt('story'), text)
  stamp++; text = ''
  assert.throws(() => prompt('story'), /不能为空/)
  text = '恢复后的正文'
  assert.equal(prompt('story'), text)
  assert.throws(() => prompt('../secret'), /未知提示词/)
})

const missingFile = () => Object.assign(new Error("ENOENT: no such file or directory, stat '/app/tavern-plugin/prompts/story.md'"), { code: 'ENOENT' })
