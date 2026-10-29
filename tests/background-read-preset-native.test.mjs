import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { createBackgroundNativeRuntime } from './fixtures/background-native-runtime.mjs'

test('实际后台预设提供只读文件工具，真实宿主结算启动且可读取资料', { skip: !process.env.DSH_BOOT_MODULE, timeout: 30000 }, async t => {
  const patch = parse(await readFile(new URL('../tavern-plugin/cordis.patch.yml', import.meta.url), 'utf8'), { logLevel: 'silent' })
  const preset = patch.flatMap(row => row.insert || []).find(row => row.id === 'preset-tavern-background')
  const row = preset.config.plugins.find(row => row.name === '@deepseek-ai/dsh-tool-fs')
  assert.ok(row, '后台预设必须提供原生 read')
  assert.deepEqual(row.config, { read: true, readImage: false, write: false, edit: false })
  let host
  const runtime = await createBackgroundNativeRuntime(process.env.DSH_BOOT_MODULE, {
    fileTools: row.config,
    setupHost(ctx) {
      host = ctx
      assert.ok(ctx.tools.get('read'))
      for (const name of ['write', 'edit', 'read_image']) assert.equal(ctx.tools.get(name), undefined)
    }
  })
  t.after(() => runtime.dispose())
  const result = await runtime.runBackground({
    sessionId: 'scene-parent', task: 'settlement', persistent: true,
    selection: { provider: 'scene-fixture', model: 'fixture-text' },
    worldbookSkillsEnabled: true, webSearchEnabled: true,
    messages: [{ role: 'user', content: [{ type: 'text', text: '检查本轮状态。' }] }], tools: []
  })
  assert.equal(result.text, '已完成。')
  const names = runtime.requests.at(-1).tools.map(tool => tool.name)
  assert.ok(names.includes('read'))
  assert.ok(names.includes('skill'))
  for (const name of ['write', 'edit', 'read_image']) assert.equal(names.includes(name), false)
  const read = await host.tools.execute({
    calls: [{ type: 'tool-call', id: 'read-fixture', name: 'read', arguments: JSON.stringify({ file_path: new URL('./background-read-preset-native.test.mjs', import.meta.url).pathname }) }],
    agent: host.agents.get(result.traceSessionId), signal: new AbortController().signal
  })
  assert.equal(read.results.length, 1)
  assert.equal(read.results[0].result.isError, false, JSON.stringify(read.results))
  assert.match(JSON.stringify(read.results[0].result.content), /worldbookSkillsEnabled/)
})
