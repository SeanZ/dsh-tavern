import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { EventEmitter, getEventListeners, once } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('../tavern-plugin/lib/domain/server-script-worker.js', import.meta.url), 'utf8')
const bridgeSource = source.slice(source.indexOf('\nlet fetchSequence'), source.indexOf('// ---- Module loading'))
const origin = 'http://tavern.invalid'
const route = '/api/dsh-tavern/getSession'

function loadBridge(channel, send) {
  return runInNewContext(bridgeSource + '\n({ fetch: bridgeFetch(Response), pending: () => fetches.size })', {
    process: channel, send, ORIGIN: origin, URL, Response, Buffer
  })
}

function reply(id, body) {
  return { type: 'fetch-result', id, status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)).toString('base64') }
}

function listenerCount(signal) {
  return getEventListeners(signal, 'abort').length
}

if (process.argv[2] === '--bridge-fixture') {
  const { fetch, pending } = loadBridge(process, message => process.send(message))
  const first = new AbortController()
  const second = new AbortController()
  const reason = new Error('IPC 请求已取消')
  process.on('message', message => {
    if (message.type === 'abort-test-request') first.abort(reason)
  })
  await assert.rejects(fetch(route, { method: 'POST', body: '{"openingWindow":1}', signal: first.signal }), error => error === reason)
  const cancelled = { pending: pending(), listeners: listenerCount(first.signal) }
  const response = await fetch(route, { method: 'POST', body: '{"openingWindow":1}', signal: second.signal })
  process.send({
    type: 'test-result', cancelled, pending: pending(), listeners: listenerCount(second.signal), body: await response.json()
  }, () => process.disconnect())
} else {
  test('预取消的 init 和 Request signal 不发送 IPC', async () => {
    const sent = []
    const { fetch, pending } = loadBridge(new EventEmitter(), message => sent.push(message))
    const controller = new AbortController()
    const request = new Request(origin + route, { signal: controller.signal })
    const reason = new Error('发出前已取消')
    controller.abort(reason)

    await assert.rejects(fetch(route, { signal: controller.signal }), error => error === reason)
    await assert.rejects(fetch(request), error => error === reason)
    assert.deepEqual(sent, [])
    assert.equal(pending(), 0)
    assert.equal(listenerCount(controller.signal), 0)
    assert.equal(listenerCount(request.signal), 0)
  })

  test('正常及失败回复均清理待处理项和监听器', async () => {
    const channel = new EventEmitter()
    const sent = []
    const { fetch, pending } = loadBridge(channel, message => sent.push(message))
    const controller = new AbortController()
    const result = fetch(route, { signal: controller.signal })
    assert.equal(pending(), 1)
    assert.equal(listenerCount(controller.signal), 1)
    channel.emit('message', reply(sent[0].id, { ok: true }))
    assert.deepEqual(await (await result).json(), { ok: true })
    assert.equal(pending(), 0)
    assert.equal(listenerCount(controller.signal), 0)

    const failure = fetch(route, { signal: controller.signal })
    channel.emit('message', { type: 'fetch-result', id: sent[1].id, error: 'IPC 请求失败' })
    await assert.rejects(failure, /IPC 请求失败/)
    assert.equal(pending(), 0)
    assert.equal(listenerCount(controller.signal), 0)
  })

  test('真实 IPC 中在途取消清理待处理项，迟到回复不干扰下一次请求', { timeout: 5000 }, async t => {
    const child = fork(import.meta.filename, ['--bridge-fixture'], { execArgv: [], serialization: 'advanced' })
    t.after(() => child.kill())
    const exited = once(child, 'exit')
    const requests = []
    let cancelledId, result
    child.on('message', message => {
      if (message.type === 'test-result') result = message
      if (message.type !== 'fetch') return
      requests.push([message.path, message.method, message.body])
      if (cancelledId === undefined) {
        cancelledId = message.id
        child.send({ type: 'abort-test-request' })
        return
      }
      child.send(reply(cancelledId, { text: '迟到回复' }))
      child.send(reply(message.id, { text: '正常回复' }))
    })

    assert.deepEqual(await exited, [0, null])
    assert.deepEqual(requests, Array(2).fill([route, 'POST', '{"openingWindow":1}']))
    assert.deepEqual(result, {
      type: 'test-result', cancelled: { pending: 0, listeners: 0 }, pending: 0, listeners: 0, body: { text: '正常回复' }
    })
  })
}
