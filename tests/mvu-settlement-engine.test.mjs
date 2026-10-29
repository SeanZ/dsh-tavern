import assert from 'node:assert/strict'
import test from 'node:test'
import { createMvuSettlementEngine } from '../tavern-plugin/lib/domain/mvu-settlement-engine.js'

const engine = createMvuSettlementEngine({})
const official = { enabled: true, owner: 'official' }
const game = mvu => ({ mvu: official, messages: [{ role: 'user' }, { role: 'assistant', turn: 2, swipeId: 0, variables: [{ stat_data: { hp: 1 } }], mvu }] })

test('official MVU settles automatically even when legacy settings disabled variables', () => {
  assert.equal(engine.target({ ...game({ pending: true }), mvu: { enabled: true, owner: 'card' } }), null)
  assert.equal(engine.runs(engine.target({ ...game({ pending: true }), mvu: null })), false)
  assert.equal(engine.settings({ ...game({ pending: true }), backgroundTasks: { variables: false } }).variables, true)
  const target = engine.target(game({ pending: true }))
  assert.equal(target.messageId, 1)
  assert.equal(engine.runs(target, { variables: false }), true)
  assert.equal(engine.runs(engine.target(game({ pending: true, pendingSubmission: {} })), { variables: false }), true)
  assert.deepEqual(engine.settings(game({ pending: true, variableRetry: true })).posture, false, 'a variable retry settles the variables alone')
})

test('a retry redelivers a waiting submission as saved, or restarts the variables; never both', () => {
  const plain = { chat: { mvu: null }, target: {}, activity: {} }
  assert.equal(engine.prepareRetry(plain), 'none')
  const waiting = () => ({ chat: { mvu: official }, target: { message: { swipeId: 0, mvu: { receipt: { status: 'pending' }, pendingSubmission: {} } } }, activity: { phase: 'pending' } })
  assert.equal(engine.prepareRetry(waiting()), 'redeliver')
  assert.throws(() => engine.prepareRetry({ ...waiting(), guidance: '多加点血' }), /只能重新投递/)
  const done = { chat: { mvu: official }, target: { message: { swipeId: 0, mvuBaseline: { swipeId: 0 }, mvu: { receipt: { status: 'updated' }, guidance: '旧意见' } } }, activity: {} }
  assert.equal(engine.prepareRetry({ ...done, guidance: ' 新意见 ' }), 'reset')
  assert.deepEqual(done.target.message.mvu, { pending: true, variableRetry: true, guidance: '新意见', modified: false, diagnostics: [], events: [] })
  const noBaseline = { chat: { mvu: official }, target: { message: { swipeId: 0, mvu: { receipt: { status: 'updated' } } } }, activity: {} }
  assert.throws(() => engine.prepareRetry(noBaseline), /没有结算前快照/)
})

function providerRun({ saved = false, active = true, tasks = { posture: false, characterDesign: false }, modelSelection = { model: 'm' }, unloadDuringResume = false, unloadDuringAuxiliary = false } = {}) {
  const variables = { stat_data: { hp: 2 }, schema: {} }
  const message = { role: 'assistant', turn: 2, swipeId: 0, text: '小火龙出现。', variables: [variables],
    mvuBaseline: { swipeId: 0, variables }, mvu: { pending: true,
      ...(saved ? { pendingSubmission: { operations: [{ op: 'replace', path: '/stat_data/hp', value: 3 }] },
        delivery: { branchId: 'branch', revision: 7, lifecycleRevision: 2, swipeId: 0, provider: { owner: 'card-plugin' }, auxiliaryPending: true } } : {}) } }
  const snapshot = { id: 'chat', sessionId: 'game', mvu: { enabled: true, owner: 'official' },
    tavernHelperLifecycleRevision: 2, messages: [{ role: 'user', text: '选小火龙' }, message], guides: [] }
  const calls = []
  let failAuxiliaryOnce = false
  let activeNow = active
  let registered = true
  const taskRun = { operationId: 'operation', basedOn: { branchId: 'branch', revision: 7 },
    async checkpointMessage(_id, update) { update(snapshot, message) },
    async bindSession() {} }
  const pluginApi = {
    async mvuProvider(input) { calls.push(['provider', input]); return { owner: 'card-plugin', operations: [{ op: 'replace', path: '/stat_data/hp', value: 3 }] } },
    async mvuProviderActive(input) { calls.push(['active', input]); return activeNow },
    mvuProviderRegistered(owner) { return registered && owner === 'card-plugin' }
  }
  const mvuSettlement = {
    async resumeProviderVariables(input) {
      calls.push(['provider-resume', input])
      await input.onSubmission(input.submission)
      if (unloadDuringResume) activeNow = false
      return { submission: input.submission, variables, receipt: { status: 'updated' }, effect: { changes: [] } }
    },
    async resumeVariables(input) {
      calls.push(['resume', input])
      await input.onSubmission(input.submission)
      return { submission: input.submission, variables, receipt: { status: 'updated' }, effect: { changes: [] } }
    },
    async settleVariables(input) { calls.push(['model', input]); return { receipt: { status: 'unchanged' } } },
    async settleAuxiliary(input) {
      calls.push(['auxiliary', input])
      if (failAuxiliaryOnce) { failAuxiliaryOnce = false; throw new Error('aux interrupted') }
      if (unloadDuringAuxiliary) activeNow = false
      return { posture: '站在路旁', text: '' }
    }
  }
  const engine = createMvuSettlementEngine({ pluginApi, mvuSettlement,
    mvuUpdateRules: async () => [], backgroundModelSelection: () => modelSelection, postureItem: { requirement: () => 'pose' },
    tavernScriptDispatch: { status: () => ({}) } })
  const target = engine.target(snapshot)
  return { engine, snapshot, message, taskRun, target, calls, mvuSettlement, tasks,
    failAuxiliaryOnce() { failAuxiliaryOnce = true }, setRegistered(value) { registered = value } }
}

function ownerGuardEffect() {
  return { version: 1, operationId: 'operation', chatId: 'chat', sessionId: 'game', branchId: 'branch', basedOnRevision: 7,
    expectedLifecycleRevision: 2, messageId: 1, swipeId: 0,
    changes: [{ op: 'replace', path: ['messages', 1, 'variables', 0, 'stat_data', 'hp'], value: 99 }] }
}

test('MVU engine：恢复事务与aux之间断开后保留 auxiliaryPending，重试不调用provider且补齐prepared', async () => {
  const run = providerRun({ saved: true, tasks: { posture: true, characterDesign: true } })
  run.failAuxiliaryOnce()
  const args = { snapshot: run.snapshot, taskRun: run.taskRun, card: { name: '小智' }, signal: new AbortController().signal,
    trace: { sessionId: 'session', boundary: null }, backgroundTasksSettings: run.tasks, mvuTarget: run.target }
  await assert.rejects(run.engine.run(args), /aux interrupted/)
  assert.equal(run.message.mvu.delivery.auxiliaryPending, true)
  assert.equal(run.message.mvu.delivery.prepared, undefined, 'resume cannot prematurely mark provider delivery prepared')
  await run.engine.run(args)
  assert.equal(run.calls.filter(([kind]) => kind === 'provider').length, 0)
  assert.equal(run.calls.filter(([kind]) => kind === 'resume').length, 2)
  assert.equal(run.calls.filter(([kind]) => kind === 'auxiliary').length, 2)
  assert.equal(run.message.mvu.delivery.auxiliaryPending, false)
  assert.ok(run.message.mvu.delivery.prepared)
})
