import assert from 'node:assert/strict'
import test from 'node:test'

import { createInstallStageReporter } from '../bin/application-update.mjs'

test('跨块的 UTF-8 字符不产生乱码，阶段只在变化时上报、进展按心跳节流', () => {
  const stages = []
  let progress = 0
  let now = 6000
  const reporter = createInstallStageReporter({
    onStage: stage => stages.push(stage), onProgress: () => { progress += 1 }, now: () => now, heartbeatMs: 5000,
  })
  const text = Buffer.from('== [步骤 2] 安装依赖（已用 3s）==\nDSH_STATUS 下载代码：1/8\nDSH_STATUS 下载代码：2/8\n', 'utf8')
  // Split inside the first Chinese character of the step title.
  const cut = text.indexOf(Buffer.from('安')) + 1
  reporter.push(text.subarray(0, cut))
  assert.deepEqual(stages, [])
  reporter.push(text.subarray(cut))
  assert.deepEqual(stages, ['第 2 步 · 安装依赖', '下载代码：1/8', '下载代码：2/8'])
  assert.equal(progress, 1, '同一秒内的多行输出只刷新一次进展')
  now = 12000
  reporter.push(Buffer.from('下载中\n', 'utf8'))
  assert.equal(progress, 2, '心跳按时间窗刷新，不受行数影响')
  reporter.end()
  assert.deepEqual(stages.slice(0, 3), ['第 2 步 · 安装依赖', '下载代码：1/8', '下载代码：2/8'])
})
