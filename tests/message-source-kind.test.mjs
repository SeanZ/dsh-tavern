import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { producerKind, producerSource } from '../tavern-plugin/lib/domain/message-source.js'

const root = fileURLToPath(new URL('../tavern-plugin', import.meta.url))

test('producerKind 与 DSH v3→v4 迁移推导一致', function () {
  assert.equal(producerKind('dsh-tavern'), 'plugin:dsh-tavern')
  assert.equal(producerKind('dsh-tavern-regen'), 'plugin:dsh-tavern-regen')
  assert.equal(producerKind('@deepseek-ai/dsh-system-prompt', 'system'), 'system-prompt')
  assert.equal(producerKind('@deepseek-ai/dsh-system-prompt'), 'runtime-context')
  assert.equal(producerSource('dsh-tavern', { form: 'snapshot' }).kind, 'plugin:dsh-tavern')
  assert.deepEqual(producerSource('dsh-tavern'), { kind: 'plugin:dsh-tavern' })
})

// 会话格式 v4 的 source() 校验拒收裸 kind:'plugin'（报
// 「format v4 message requires a producer-owned source kind」），
// 所以 Tavern 任何写入点都不该再出现「kind: 'plugin', plugin: '…'」这一对。
