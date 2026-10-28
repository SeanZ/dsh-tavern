import assert from 'node:assert/strict'
import test from 'node:test'
import { registerTavernHttpRoutes } from '../tavern-plugin/lib/http/routes.js'

// Rejected requests must never reach the application dispatcher.
function route(updater) {
  const dispatch = async method => {
    assert.equal(method, 'cancelUpdate')
    return { status: await updater.cancel() }
  }
  let handler
  const webServer = { register(spec) { if (spec.path === '/api/dsh-tavern') handler = spec.handler; return () => {} } }
  registerTavernHttpRoutes({ ctx: { get: name => name === 'webServer' ? webServer : { requestRejection: () => undefined }, effect: fn => fn() }, dispatch, str: String,
    performanceDiagnostics: { http() {} }, runtimeGeneration: 'test-generation', runtimeReadiness: Promise.resolve({ ok: true }) })
  return async ({ method = 'POST', origin, body = '{}' } = {}) => {
    const result = {}
    await handler({ url: '/api/dsh-tavern/cancelUpdate', method, headers: { host: 'localhost:3081', ...(origin ? { origin } : {}) },
      async *[Symbol.asyncIterator]() { yield Buffer.from(body) }
    }, { writeHead(status, headers) { Object.assign(result, { status, headers }) }, end(response) { result.body = response } })
    return result
  }
}

test('取消更新拒绝 GET、跨站和损坏请求且不触发取消', async () => {
  let calls = 0
  const request = route({ async cancel() { calls++; return { phase: 'cancelling' } } })
  assert.equal((await request({ method: 'GET' })).status, 405)
  assert.equal((await request({ origin: 'https://untrusted.invalid' })).status, 403)
  assert.equal((await request({ body: '{' })).status, 400)
  assert.equal(calls, 0)
})
