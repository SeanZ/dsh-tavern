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

test('更新期间提示词文件被新版删除时，沿用上一次读到的正文', () => {
  let deleted = false
  const prompt = createPromptCatalog(undefined, {
    version: () => { if (deleted) throw missingFile(); return 1 },
    read: () => { if (deleted) throw missingFile(); return '更新前读到的正文' },
  })
  assert.equal(prompt('story'), '更新前读到的正文')
  deleted = true
  assert.equal(prompt('story'), '更新前读到的正文')
})

test('从未读到过的提示词文件缺失时，说明是更新或尚未重启', () => {
  const prompt = createPromptCatalog(undefined, { version: () => { throw missingFile() }, read: () => '' })
  assert.throws(() => prompt('story'), /提示词文件 story\.md 不存在.*重启酒馆后重试/)
})

test('读文件时文件被换掉，不把这一份写进缓存', () => {
  let stamp = 1, text = '第一版'
  const prompt = createPromptCatalog(undefined, { version: () => stamp, read: () => text })
  assert.equal(prompt('story'), '第一版')
  stamp = 2
  // 读取期间版本又变了一次：读完的正文仍返回，但下一次还要重新读。
  const original = text
  text = '第二版'
  assert.equal(prompt('story'), '第二版')
  stamp = 3
  text = original
  assert.equal(prompt('story'), '第一版')
})
