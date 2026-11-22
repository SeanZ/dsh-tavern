import assert from 'node:assert/strict'
import test from 'node:test'
import { tavernRequestRejection } from '../tavern-plugin/lib/http/connection-admission.js'

test('仅接受宿主核准且仍在线的 owner，并保留旧版拒绝状态', () => {
  const ac = new AbortController()
  const result = { peer: { signal: ac.signal, principal: { kind: 'owner' } } }
  const connection = { admit: () => result }
  assert.equal(tavernRequestRejection(connection, {}), undefined)
  result.peer.principal.kind = 'agent'
  assert.equal(tavernRequestRejection(connection, {}), 403)
  ac.abort()
  assert.equal(tavernRequestRejection(connection, {}), 401)
  assert.equal(tavernRequestRejection({ requestRejection: () => 403 }, {}), 403)
  assert.equal(tavernRequestRejection({}, {}), 503)
})

test('路由传入的身份决定该请求，失效后不能退回旧接口放行', () => {
  const ac = new AbortController()
  const connection = { requestRejection: () => undefined }
  const request = {}
  assert.equal(tavernRequestRejection(connection, request, { principal: { kind: 'agent' }, signal: ac.signal }), 403)
  const peer = { principal: { kind: 'owner' }, signal: ac.signal }
  assert.equal(tavernRequestRejection(connection, request, peer), undefined)
  ac.abort()
  assert.equal(tavernRequestRejection(connection, request, peer), 403)
})
