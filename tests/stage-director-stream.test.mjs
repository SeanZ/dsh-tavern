import assert from 'node:assert/strict'
import test from 'node:test'
import { createStageDirectorStream, observeStageText } from '../tavern-plugin/lib/domain/stage-director-stream.js'
import { stageDirectorFixture } from './helpers/stage-director-fixture.mjs'

const text = 'One.\nTwo.\nThree.\nFour.\nFive.\nSix.\nSeven.'
const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await tick() } assert.fail('condition did not settle') }
async function fixture(run) {
  const assets = { player: 'Reader', cast: [{ name: 'Nora' }], background: [{ name: 'Room' }], music: [{ name: 'Theme' }] }
  const reference = { input: 'Continue.', cardContext: 'Frozen card.', activeWorldbook: 'Frozen lore.', currentStateProjection: 'Before settlement.' }
  const prompts = [], receipts = [], errors = []
  const h = await stageDirectorFixture({ id: 'story', sessionId: 'game', mode: 'story', timeline: {
    branchId: 'branch', revision: 1, operations: { body: { id: 'body', kind: 'body', status: 'running', turn: 2 } }
  }, messages: [{ role: 'assistant', turn: 1, text: 'Opening.' }] }, assets, {
    readContext: async () => reference,
    runAgent: async input => {
      const context = JSON.parse(input.turnContext), { first, ...seal } = context.window
      prompts.push({ input, context })
      const call = async delta => { const receipt = JSON.parse(await input.onToolCall({ arguments: { ...seal, ...delta } })); receipts.push(receipt); return receipt }
      if (run) await run({ input, context, call })
      else await call(context.window.sequence === 1 ? { figures: [{ speaker: 'Nora' }], background: 'Room', music: 'Theme', performances: [{ at: 1, op: 'actor.act.play', actor: 'Nora', motion: 'nod' }] } : { performances: [{ at: 6, op: 'actor.act.play', actor: 'Nora', motion: 'jump' }] })
    }
  })
  const source = async () => {
    const chat = await h.read(), operation = chat.timeline.operations.body
    return { chatId: chat.id, operationId: operation.id, status: operation.status, branchId: chat.timeline.branchId, revision: chat.timeline.revision }
  }
  const stream = createStageDirectorStream({ director: h.director, source, catalog: async () => assets, warn: error => errors.push(error.message) })
  async function submit(finalText = text) {
    await h.persistence.update('story', chat => { chat.messages.push({ role: 'assistant', turn: 2, text: finalText }); chat.timeline.revision++; chat.timeline.operations.body.status = 'completed'; return chat })
    return h.body()
  }
  return { ...h, stream, submit, source, prompts, receipts, errors, reference }
}

test('window envelope and events repair in the same request; sealed pages cannot be rewritten', async () => {
  const h = await fixture(async ({ context, call }) => {
    assert.equal((await call({ through: 99 })).ok, false)
    assert.equal((await call({ sequence: 99 })).ok, false)
    assert.equal((await call({ done: !context.window.done })).ok, false)
    assert.equal((await call({ performances: [{ at: context.window.first === 1 ? 6 : 1, op: 'screen.play', effect: 'shake-1' }] })).ok, false)
    assert.equal((await call({})).ok, true)
  })
  ;(await h.stream.begin('game', 2)).append(text)
  await until(() => h.receipts.length === 5)
  assert.equal(await h.data.snapshot('story'), null)
  await h.stream.finish(await h.submit())
  assert.equal(h.prompts.length, 2)
  assert.equal(h.receipts.filter(value => value.ok).length, 2)
  assert.deepEqual(h.errors, [])
})

test('the remainder window reads the directed pages and played one-shots read-only; the first window reads only its own pages', async () => {
  const h = await fixture(async ({ context, call }) => {
    await call(context.window.sequence === 1 ? { figures: [{ speaker: 'Nora' }], performances: [{ at: 2, op: 'actor.act.play', actor: 'Nora', motion: 'nod' }, { at: 4, op: 'screen.play', effect: 'shake-1' }] } : {})
  })
  ;(await h.stream.begin('game', 2)).append(text)
  await until(() => h.receipts.length === 1)
  await h.stream.finish(await h.submit())
  assert.equal(h.prompts[0].input.messages[0].content[0].text, '[1] One.\n[2] Two.\n[3] Three.\n[4] Four.\n[5] Five.')
  assert.equal(h.prompts[1].input.messages[0].content[0].text, [
    '已导演（只读，不再安排）：', '[1] One.', '[2] Two.', '[3] Three.', '[4] Four.', '[5] Five.',
    '已演出（不重复）：[2] actor.act.play Nora nod；[4] screen.play shake-1', '本窗口：', '[6] Six.', '[7] Seven.'].join('\n'))
  assert.deepEqual(h.errors, [])
})

for (const change of ['prefix', 'catalog', 'branch', 'operation', 'cancel']) test('stale stream cannot persist either channel: ' + change, async () => {
  const h = await fixture(), observer = await h.stream.begin('game', 2)
  observer.append(text)
  await until(() => h.receipts.length === 1)
  const body = await h.submit(change === 'prefix' ? text.replace('One.', 'Replaced.') : text)
  if (change === 'catalog') h.assets.music.push({ name: 'New' })
  if (change === 'branch') await h.persistence.update('story', chat => { chat.timeline.branchId = 'other'; return chat })
  if (change === 'operation') await h.persistence.update('story', chat => { chat.timeline.operations.body.id = 'replacement'; return chat })
  await h.stream.finish(body, change === 'cancel' ? AbortSignal.abort() : undefined)
  assert.equal(await h.data.snapshot('story'), null)
  assert.equal(await h.stream.preview('game'), null)
  assert.ok(h.errors.length)
})

for (const count of [3, 5]) test('short or exact-five body needs only one director request: ' + count, async () => {
  const h = await fixture(async ({ call }) => { await call({}) })
  const observer = await h.stream.begin('game', 2), bodyText = text.split('\n').slice(0, count).join('\n')
  observer.append(bodyText + '\n')
  if (count === 5) await until(() => h.receipts.length === 1)
  await h.stream.finish(await h.submit(bodyText))
  assert.equal(h.prompts.length, 1)
  assert.ok(await h.data.snapshot('story'))
  assert.deepEqual(h.errors, [])
})

for (const template of ['{{setvar::x::1}}', '<% print(value) %>', '<script>\nprogram\n</script>']) test('effectful or executable source waits for host final projection: ' + template, async () => {
  const h = await fixture(async ({ call }) => { await call({}) })
  ;(await h.stream.begin('game', 2)).append(template + '\n' + text)
  await tick(); assert.equal(h.prompts.length, 0)
  await h.stream.finish(await h.submit())
  assert.equal(h.prompts.length, 1)
  assert.equal(h.prompts[0].context.window.through, 7)
  assert.deepEqual(h.errors, [])
})

test('a predecessor changed during generation rejects final publication under the journal lock', async () => {
  const h = await fixture()
  ;(await h.stream.begin('game', 2)).append(text)
  await until(() => h.receipts.length === 1)
  await (await h.prepare()).call({ background: 'Room' })
  const body = await h.submit()
  await h.stream.finish(body)
  assert.equal(await h.director.presentation('game', 2, body.key), null)
  assert.ok(h.errors.length)
})

test('late tools after cancellation cannot revive a prefix', async () => {
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const h = await fixture(async ({ call }) => { await blocked; assert.equal((await call({})).ok, false) })
  const observer = await h.stream.begin('game', 2)
  observer.append(text)
  await until(() => h.prompts.length === 1)
  h.stream.cancel('game', 1)
  assert.ok(await h.stream.preview('game'), 'a late end for another turn cannot cancel this generation')
  observer.cancel(); release()
  await until(() => h.receipts.length === 1)
  assert.equal(await h.stream.preview('game'), null)
  assert.equal(await h.data.snapshot('story'), null)
})

test('stream observation buffers preparation without blocking tokens; errors/cancellation discard late setup', async () => {
  let release, cancels = 0
  const bytes = [], wait = new Promise(resolve => { release = resolve })
  const observer = observeStageText({ begin: async () => { await wait; return { append: text => bytes.push(text), cancel: () => cancels++ } } })
  observer.append('a'); observer.append('b')
  release(); await observer.finish(true)
  assert.deepEqual(bytes, ['ab'])
  const controller = new AbortController()
  const cancelled = observeStageText({ signal: controller.signal, begin: async () => ({ append: text => bytes.push(text), cancel: () => cancels++ }) })
  cancelled.append('never'); controller.abort(); await cancelled.finish(false)
  assert.deepEqual(bytes, ['ab'])
  assert.equal(cancels, 1)
})
