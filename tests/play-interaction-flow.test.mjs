import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlayInteractionFlow } from '../tavern-plugin/lib/domain/play-interaction-flow.js'
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function harness(rpc) {
  const errors = [], views = [], bodies = []
  const flow = createPlayInteractionFlow({ rpc, coordinationView: value => value,
    coordination: { setView: (...args) => views.push(args), invalidate() {} },
    applyBodyResult: (...args) => bodies.push(args), reportError: (...args) => errors.push(args),
    timers: { setTimeout: (fn, ms) => setTimeout(fn, ms === 250 ? 0 : ms), clearTimeout } })
  return { flow, errors, views, bodies }
}
test('candidate admission retries share one request id and overlapping submits share work', async () => {
  const requests = []
  const h = harness(async (_method, args) => { requests.push(args); if (requests.length === 1) throw new Error('Failed to fetch'); return { task: { status: 'queued' } } })
  const one = h.flow.submitCandidateTask('a', 'm', 'guide'), two = h.flow.submitCandidateTask('a', 'm', 'guide')
  assert.equal(one, two)
  assert.equal((await one).status, 'queued')
  assert.equal(requests.length, 2)
  assert.equal(requests[0].requestId, requests[1].requestId)
  await h.flow.submitCandidateTask('a', 'm', 'guide')
  assert.equal(requests.length, 3)
})
test('late candidate guide completion cannot dismiss another session panel', async () => {
  const wait = deferred(), h = harness(() => wait.promise)
  const panel = h.flow.guide.set({ sessionId: 'a', messageId: 'm', phase: 'input' })
  const pending = h.flow.regenerateCandidates(panel, 'guide')
  assert.equal(h.flow.guide.getSnapshot().phase, 'loading')
  const next = h.flow.guide.set({ sessionId: 'b', messageId: 'other', phase: 'input' })
  wait.resolve({ task: {} }); await pending
  assert.equal(h.flow.guide.getSnapshot(), next)
})
test('candidate failures release busy state; cancellation restores previous choices', async () => {
  const h = harness(async () => { throw new Error('denied') })
  const previous = { sessionId: 'a', messageId: 'm', phase: 'ready', choices: ['old'], expanded: true }
  const panel = h.flow.guide.set({ sessionId: 'a', messageId: 'm', phase: 'input', previous })
  await h.flow.regenerateCandidates(panel, 'guide')
  assert.equal(h.flow.guide.getSnapshot().phase, 'input')
  assert.equal(h.flow.candidates.getSnapshot().phase, 'error')
  h.flow.cancelGuide(h.flow.guide.getSnapshot())
  assert.equal(h.flow.guide.getSnapshot(), null)
  assert.deepEqual(h.flow.candidates.getSnapshot().choices, ['old'])
})
test('body regeneration owns busy state and guidance, ignores double submit and preserves a newer panel', async () => {
  const wait = deferred(), calls = [], h = harness(async (...args) => { calls.push(args); return wait.promise })
  const panel = h.flow.regeneration.set({ sessionId: 'a', phase: 'input', tail: 'tail' })
  const pending = h.flow.regenerateBody(panel, ' 改写 ', { restyle: true, styleGuidance: ' 文风 ' })
  await h.flow.regenerateBody(panel, 'second')
  assert.equal(h.flow.guidance('a'), '改写')
  assert.equal(h.flow.guidance('b'), '')
  const next = h.flow.regeneration.set({ sessionId: 'b', phase: 'input' })
  const candidates = h.flow.candidates.set({ sessionId: 'b', choices: ['new'] })
  wait.resolve({ view: { chatId: 'a' } }); await pending
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['regenBody', { guidance: '改写', restyle: true, styleGuidance: '文风' }, 'a'])
  assert.equal(h.flow.regeneration.getSnapshot(), next)
  assert.equal(h.flow.candidates.getSnapshot(), candidates)
  assert.deepEqual(h.bodies, [['a', { chatId: 'a' }, 'tail']])
})
test('panel subscriptions release and matching candidate refresh retains collapsed state', () => {
  const h = harness(), snapshots = []
  const release = h.flow.candidates.subscribe(value => snapshots.push(value))
  h.flow.candidates.set({ sessionId: 'a', messageId: 'm', phase: 'ready', choices: ['one'], expanded: true })
  h.flow.candidates.set({ sessionId: 'a', messageId: 'm', phase: 'ready', choices: ['one'] })
  assert.equal(h.flow.candidates.getSnapshot().expanded, true)
  release(); h.flow.candidates.set(null)
  assert.equal(snapshots.length, 2)
})

test('被截断的重新生成在正文落地后给出保留提示，而不是当成失败', async () => {
  const warning = '这次重新生成没有完成（可能被内容审核拦截或已停止），已保留生成到的部分正文。'
  const h = harness(async () => ({ view: { chatId: 'a', regenerationWarning: warning } }))
  const panel = h.flow.regeneration.set({ sessionId: 'a', phase: 'input', tail: 'tail' })
  await h.flow.regenerateBody(panel, '')
  // The body is applied first: the partial text is the round's text now.
  assert.deepEqual(h.bodies, [['a', { chatId: 'a', regenerationWarning: warning }, 'tail']])
  assert.deepEqual(h.errors.map(([source, error]) => [source, error.message]), [['重新生成提示', warning]])
  assert.equal(h.flow.regeneration.getSnapshot(), null)
})
