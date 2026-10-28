import assert from 'node:assert/strict'
import test from 'node:test'
import { registerTavernHttpRoutes } from '../tavern-plugin/lib/http/routes.js'

test('POST API 保留错误码而不泄漏错误对象中的额外数据', async () => {
  let handler
  const webServer = { register(route) { if (route.path === '/api/dsh-tavern') handler = route.handler; return () => {} } }
  const failure = Object.assign(new Error('脚本写入不属于当前 MVU 结算事件'), {
    code: 'MVU_SETTLEMENT_EVENT_MISMATCH', privateState: 'PRIVATE-STORY'
  })
  registerTavernHttpRoutes({
    ctx: { get: name => name === 'webServer' ? webServer : { requestRejection: () => undefined }, effect(callback) { callback() } },
    dispatch: async () => { throw failure }, str: value => String(value ?? ''),
    performanceDiagnostics: { http() {} }, runtimeGeneration: 'test-generation',
    runtimeReadiness: Promise.resolve({ ok: true })
  })
  assert.equal(typeof handler, 'function')

  let status, body
  await handler({ url: '/api/dsh-tavern/updateTavernHelperVariables', method: 'POST', headers: { host: 'localhost:3081' },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{}') }
  }, {
    writeHead(value) { status = value },
    end(value) { body = value }
  })

  assert.equal(status, 200)
  assert.deepEqual(JSON.parse(body), { ok: false, error: failure.message, errorCode: failure.code })
  assert.doesNotMatch(body, /PRIVATE-STORY|stack/)
})
