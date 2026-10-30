import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

// Host adapters only: apply(), HTTP dispatch, storage, and projections stay real.
// Call from an isolated child process with its own DSH_HOME.
export async function createPluginHost({ withTools = false } = {}) {
  globalThis.fetch = async () => new Response('/* test asset */', { headers: { 'content-type': 'text/css' } })
  const { apply } = await import('../../tavern-plugin/lib/index.js')
  const routes = new Map(), events = new Set(), disposers = []
  const services = new Map([
    // 仅适配此进程内夹具的固定 Host；真实鉴权由 tavern-http-origin 与浏览器回归验证。
    ['connection', { requestRejection: req => req.headers.host === 'fixture.test' ? undefined : 403 }],
    ['settings', { describe: () => [] }], ['llm', {}],
    ['tokenMeter', { _foldEvent() {} }], ['skills', { registerProvider() {} }],
    ['agentPresets', { resolvedRoots: [] }], ['agents', new Map()], ['sessions', new Map()],
    ['webServer', { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } }]
  ])
  const registeredTools = new Map()
  const tools = {
    get: name => registeredTools.get(name),
    register(tool) {
      assert.ok(!registeredTools.has(tool.name), 'duplicate tool: ' + tool.name)
      registeredTools.set(tool.name, tool)
    }
  }
  if (withTools) services.set('tools', tools)
  const dispose = async () => { for (const callback of disposers.reverse()) await callback() }
  try {
    await apply({
      tools,
      get: name => services.get(name),
      inject(names, callback) { if (names.every(name => services.has(name))) return callback(this) },
      llm: services.get('llm'),
      settings: services.get('settings'),
      effect(callback) { const stop = callback(); if (typeof stop === 'function') disposers.push(stop) },
      on: name => events.add(name),
      provide: (name, value) => services.set(name, value)
    })
    await new Promise(resolve => setImmediate(resolve))
  } catch (error) { await dispose(); throw error }
  return {
    services, events, registeredTools, dispose,
    async rpc(method, args = {}) {
      const req = Readable.from([Buffer.from(JSON.stringify(args))])
      Object.assign(req, { method: 'POST', url: '/api/dsh-tavern/' + method, headers: { host: 'fixture.test' } })
      let status, body
      await routes.get('/api/dsh-tavern')(req, { writeHead(code) { status = code }, end(value) { body = value } })
      assert.equal(status, 200, body)
      const result = JSON.parse(body)
      assert.equal(result.ok, true, result.error)
      return result
    }
  }
}
