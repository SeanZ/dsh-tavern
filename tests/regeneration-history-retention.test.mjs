import assert from 'node:assert/strict'
import test from 'node:test'

import { projectRegenerationRequestMessages } from '../tavern-plugin/lib/domain/foreground-orchestration-strategies.js'

function player(text, id = '') {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function body(text) {
  return { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } }
}

function frame(text = '规则') {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-tavern' } }
}

function regenerate(text) {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-tavern-regen' } }
}

test('没有可替换的玩家输入或没有重采样输入时原样返回', () => {
  const noPlayer = [body('正文'), regenerate('重新生成')]
  assert.equal(projectRegenerationRequestMessages(noPlayer), noPlayer)
  const noRegenerate = [player('输入'), body('正文')]
  assert.equal(projectRegenerationRequestMessages(noRegenerate), noRegenerate)
  assert.deepEqual(projectRegenerationRequestMessages([]), [])
  assert.deepEqual(projectRegenerationRequestMessages(null), [])
})
