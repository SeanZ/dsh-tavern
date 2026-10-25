import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyHostVersion } from '../tavern-plugin/lib/domain/host-compatibility.js'

const policy = { minDshVersion: '0.2.0-rc.2', belowDshVersion: '0.3.0', blockedDshVersions: ['0.2.1-rc.4'] }

test('运行时按支持范围：范围内不提示，范围外、黑名单与读取失败标为不可用并提示', () => {
  for (const version of ['0.2.1-rc.2', '0.2.1-rc.3', '0.2.0-rc.2']) {
    assert.equal(classifyHostVersion(version, policy).status, 'allowed', version)
    assert.equal(classifyHostVersion(version, policy).message, '')
  }
  for (const version of ['0.2.0-rc.1', '0.2.1-rc.4', '0.3.0', '0.1.5-rc.2', '']) {
    const result = classifyHostVersion(version, policy)
    assert.equal(result.status, 'blocked', version)
    assert.match(result.message, /支持的版本：0\.2\.0-rc\.2 ≤ 版本 < 0\.3\.0/)
  }
})

// 本 fork 的 baseline 宿主是 0.2.1-rc.3：随包配置必须放行它，否则标准包 guard 在启动时抛错。
test('随包兼容配置放行 baseline 宿主 0.2.1-rc.3，同一支持线放行且越界版本拒绝', async () => {
  const { readFile } = await import('node:fs/promises')
  const shipped = JSON.parse(await readFile(new URL('../config/dsh-compatibility.json', import.meta.url), 'utf8'))
  assert.equal(classifyHostVersion('0.2.1-rc.3', shipped).status, 'allowed')
  assert.equal(classifyHostVersion('0.2.1-rc.2', shipped).status, 'allowed')
  assert.equal(classifyHostVersion('0.2.1-rc.4', shipped).status, 'allowed')
  assert.equal(classifyHostVersion('0.3.0-rc.1', shipped).status, 'blocked')
})
