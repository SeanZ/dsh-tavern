// /dream-skin/api requires the host session (connection.requestRejection) after its Host/Origin fence.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import * as skin from '../tavern-plugin/packages/dsh-dream-skin/lib/index.js'

function mount(requestRejection) {
  let handler
  const services = { connection: { trustedHosts: [], requestRejection } }
  skin.apply({ effect: fn => fn(), get: key => services[key], webServer: { register: row => { handler = row.handler } } })
  return handler
}

async function call(handler, headers, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.headers = { host: '127.0.0.1:4000', 'content-type': 'application/json', ...headers }
  const res = { status: 0, body: '', writeHead(code) { this.status = code }, end(text) { this.body = text } }
  await handler(req, res)
  return { status: res.status, json: JSON.parse(res.body) }
}

test('dream-skin API: 401 without session, 403 wrong origin, works when authenticated', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-auth-'))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    let authenticated = false
    const handler = mount(req => authenticated ? undefined : 401)
    assert.equal((await call(handler, {}, { method: 'get' })).status, 401)
    authenticated = true
    assert.equal((await call(handler, { origin: 'https://evil.test' }, { method: 'get' })).status, 403)
    assert.equal((await call(handler, { origin: 'http://127.0.0.1:4000' }, { method: 'set', patch: { accent: 'blue' } })).status, 200)
    assert.deepEqual((await call(handler, {}, { method: 'get' })).json, { ok: true, value: { accent: 'blue' } })
    assert.equal((await call(mount(undefined), {}, { method: 'get' })).status, 503)
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved
    fs.rmSync(home, { recursive: true, force: true })
  }
})
