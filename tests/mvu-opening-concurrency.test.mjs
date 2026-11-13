import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

test('真实MVU多开场与伴随回调并发保存；切换、刷新和首次发送复用各自快照', { timeout: 90000 }, async t => {
  const server = spawn(process.execPath, [fileURLToPath(new URL('./browser/mvu-initialization-browser-smoke.mjs', import.meta.url))], {
    env: { ...process.env, MVU_SMOKE_JOURNAL: '1', MVU_SMOKE_POLL_SIGNALS: '1' }, stdio: ['ignore', 'pipe', 'pipe']
  })
  t.after(() => server.kill())
  let stderr = ''
  server.stderr.on('data', chunk => { stderr += chunk })
  const url = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('启动超时：' + stderr)), 15000)
    server.once('error', reject)
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`服务退出 ${code}：${stderr}`)) })
    server.stdout.on('data', chunk => {
      output += chunk
      const match = /MVU_INITIALIZATION_SMOKE_URL=(http:\/\/[^\s]+)/.exec(output)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    })
  })
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  const ready = () => page.waitForFunction(() => {
    try { return JSON.parse(document.querySelector('#result').textContent).ready === true } catch { return false }
  }, null, { timeout: 30000 })
  await page.goto(url + '/?mode=opening-concurrent')
  await ready().catch(async error => { throw new Error(await page.locator('#result').textContent() + '\n' + JSON.stringify(await page.evaluate(() => rpc('diagnostics'))) + '\n' + errors.join('\n') + '\n' + stderr, { cause: error }) })
  const proof = await page.evaluate(() => rpc('concurrent-proof'))
  assert.equal(proof.initialization.status, 'complete')
  assert.equal(proof.templateWrites, 1)
  assert.equal(proof.metadata.template_rendered.hash, 'concurrent-template')
  assert.deepEqual(proof.variables.map(v => v.stat_data.hp), [10, 20])
  assert.deepEqual(proof.variables.map(v => v.stat_data.callbackCount), [1, 1])
  assert.deepEqual(proof.variables.map(v => v.stat_data.callbackSwipe), [0, 1])
  assert.equal(proof.modelCalls, 0)
  for (const swipeId of [1, 0, 1]) {
    await page.evaluate(swipeId => rpc('select-opening', { swipeId }), swipeId)
    await page.reload()
    await ready()
    const reloaded = await page.evaluate(() => rpc('concurrent-proof'))
    assert.deepEqual(reloaded.variables, proof.variables, '切换与重载不能重新累加初始化回调')
    assert.equal(reloaded.swipeId, swipeId)
    assert.deepEqual(await page.evaluate(() => rpc('first-send-context')), proof.variables[swipeId])
    assert.equal(reloaded.modelCalls, 0)
  }
})
