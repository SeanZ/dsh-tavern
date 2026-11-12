import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { patchSidebarTeams } from '../bin/sidebar-team-compat.mjs'
import { sourceFunction } from './fixtures/source-function.mjs'

const read = name => readFileSync(new URL('../tavern-plugin/packages/dsh-better-sidebar/lib/' + name, import.meta.url), 'utf8')
const catalog = entries => ({ state: 'ready', entries })
const child = (id, name, mode = 'continuable') => ({ id, name, mode, label: id, createdAt: 1 })
const clone = value => JSON.parse(JSON.stringify(value))

for (const name of ['client.js', 'client-registry.js']) {
  const source = read(name)
  const api = vm.runInNewContext(['teamProjectionOf', 'teamMembersOf', 'taskOwnerKey', 'taskCatalogReads', 'memberStatus'].map(fn => sourceFunction(source, fn)).join('\n') + '; ({teamProjectionOf,teamMembersOf,taskOwnerKey,taskCatalogReads})')
  test(`${name}: 冷页面递归补读目录，在途/错误不自动重试，不读无关树`, () => {
    const projections = {
      root: { state: 'ready', values: { subagentCatalog: [child('a', 'alpha'), child('error', 'error'), child('loading', 'loading'), child('external', 'external', 'external')] } },
      a: { state: 'idle', values: { subagentCatalog: [child('a1', 'worker'), child('root', 'cycle')] } },
      error: { state: 'error', values: {} }, loading: { state: 'loading', values: {} },
      unrelated: { state: 'idle', values: {} },
    }
    assert.deepEqual(clone(api.taskCatalogReads(projections, 'root')), ['a', 'a1'])
    assert.deepEqual(clone(api.taskCatalogReads({}, undefined)), [])
  })
  test(`${name}: 无投影及禁用团队不显示；启用空团队保留lead`, () => {
    assert.equal(api.teamProjectionOf({}, 'root'), undefined)
    assert.equal(api.teamProjectionOf({ root: { values: { agentTeam: { enabled: false, tasks: [{ id: 'retained' }] } } } }, 'root'), undefined)
    const team = { enabled: true, tasks: [] }
    assert.equal(api.teamProjectionOf({ root: { values: { agentTeam: team } } }, 'root'), team)
    assert.deepEqual(clone(api.teamMembersOf(undefined, {}, {}, {}, 'root')), [])
    assert.deepEqual(clone(api.teamMembersOf(team, {}, {}, {}, 'root')), [
      { id: 'root', name: 'lead', role: 'lead', phase: 'active', ownerKey: 'root', status: 'idle', diagnostics: [] },
    ])
  })
  test(`${name}: 成员来自整棵目录，区分同名分支与无名历史，过滤Side和external`, () => {
    const catalogs = {
      root: catalog([child('a', 'alpha'), child('b', 'beta'), child('old'), child('once', 'once', 'one-shot'),
        child('remote', 'remote', 'external'), { ...child('side', 'side'), label: 'Side: 提问' }]),
      a: catalog([child('a1', 'same')]), b: catalog([child('b1', 'same')]),
      old: catalog([child('old1', 'known')]), a1: catalog([child('root', 'cycle')]),
    }
    const members = api.teamMembersOf({ enabled: true, tasks: [] }, { a: { running: true }, b: { running: true } }, { b: { running: false } }, catalogs, 'root')
    assert.deepEqual(clone(members.map(m => [m.id, m.name, m.ownerKey])), [
      ['root', 'lead', 'root'], ['a', 'alpha', 'a'], ['b', 'beta', 'b'], ['old', 'old', 'old'],
      ['a1', 'alpha/same', 'a1'], ['b1', 'beta/same', 'b1'], ['old1', 'old1', 'old1'],
    ])
    assert.equal(members.find(m => m.id === 'a').status, 'running')
    assert.equal(members.find(m => m.id === 'b').status, 'idle')
    assert.equal(api.taskOwnerKey({ ownerId: 'b1', ownerName: '过时名字' }, members), 'b1')
    assert.equal(api.taskOwnerKey({ ownerId: 'unknown' }, members), 'unknown')
    assert.equal(api.taskOwnerKey({}, members), undefined)
  })
  test(`${name}: 旧宿主名单与旧分配键保持兼容`, () => {
    const members = api.teamMembersOf({ members: [{ id: 'a', name: 'alpha', role: 'teammate', phase: 'failed', error: '失败' }] }, {}, {}, {}, 'root')
    assert.equal(members[0].ownerKey, 'alpha')
    assert.equal(members[0].status, 'failed')
    assert.equal(api.taskOwnerKey({ ownerId: 'a', ownerName: 'alpha' }, members), 'alpha')
  })
  test(`${name}: 分配、选中、筛选与节点归属使用稳定身份，失败投影可见`, () => {
    assert.match(source, /props\.onPick\(member\.ownerKey\)/)
    assert.match(source, /taskOwnerKey\(task, members\) === ownerFilter/)
    assert.match(source, /const nodeId = task\.ownerId \?\? nodeByOwner.get\(task.ownerName\)/)
    assert.match(source, /team\?\.failure !== void 0/)
    assert.match(source, /disabled: props.busy \|\| task.status === "completed"/)
  })
}

test('生成适配幂等，固定分发文件均可由依赖与适配生成；锚点漂移失败', () => {
  for (const name of ['client.js', 'client-registry.js', 'index.js']) {
    assert.equal(patchSidebarTeams(read(name), name), read(name))
    assert.throws(() => patchSidebarTeams('upstream changed', name), /锚点|region/)
  }
})

const server = read('index.js')
class SidebarError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status }
}
const build = vm.runInNewContext(['stringArrayOf', 'errorCodeOf', 'requireString', 'buildTeamsApi'].map(fn => sourceFunction(server, fn)).join('\n') + '; buildTeamsApi', {
  SidebarError, TASK_ACTIONS: new Set(['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete']),
  STALE_REVISION_CODE: 'TEAM_TASK_STALE_REVISION',
})

test('rc.2写接口使用isEnabled与rootOf，转发CAS和session ID，不依赖已删除方法', async () => {
  const root = { id: 'root' }
  let enabled = true, cold = false, reads = 0
  const calls = []
  const services = {
    agents: { get: () => cold ? undefined : root },
    sessionController: { resolveAgent: async () => { reads++; return { agent: root } } },
    subagents: { rootOf: () => root },
    agentTeams: {
      isEnabled: () => enabled,
      createTask: async (agent, req) => { calls.push([agent, clone(req)]); return { id: 'task-1' } },
      updateTask: async (agent, req) => { calls.push([agent, clone(req)]); return { revision: req.expectedRevision + 1 } },
    },
  }
  const api = build({ get: name => services[name] })
  await api.taskCreate({ rootSessionId: 'root', subject: '任务', description: '说明' })
  assert.equal(calls[0][0], root)
  cold = true
  await api.taskUpdate({ rootSessionId: 'root', taskId: 'task-1', expectedRevision: 3, action: 'reassign', owner: 'child-id' })
  assert.equal(reads, 1)
  assert.deepEqual(calls[1][1], { taskId: 'task-1', expectedRevision: 3, action: 'reassign', owner: 'child-id' })
  enabled = false
  await assert.rejects(api.taskCreate({ rootSessionId: 'root', subject: '禁止' }), /enable Agent Teams/)
  enabled = true
  services.subagents.rootOf = () => ({ id: 'another' })
  await assert.rejects(api.taskCreate({ rootSessionId: 'child', subject: '禁止' }), /root Session/)
  assert.equal(calls.length, 2)
})

test('陈旧版本返回冲突，缺字段与非法动作不写入', async () => {
  const root = {}
  const services = { agents: { get: () => root }, subagents: { rootOf: () => root }, agentTeams: {
    isEnabled: () => true,
    updateTask: async () => { throw Object.assign(new Error('stale'), { code: 'TEAM_TASK_STALE_REVISION' }) },
  } }
  const api = build({ get: name => services[name] })
  await assert.rejects(api.taskUpdate({ rootSessionId: 'root', taskId: 'task-1', expectedRevision: 1, action: 'complete' }), e => e.code === 'team-conflict' && e.status === 409)
  await assert.rejects(api.taskUpdate({ rootSessionId: 'root', taskId: 'task-1', action: 'complete' }), /expectedRevision/)
  await assert.rejects(api.taskUpdate({ rootSessionId: 'root', expectedRevision: 1, action: 'unknown' }), /action/)
})
