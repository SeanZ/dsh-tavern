// 轮次导航裁剪对照真实宿主：`turnOutline` 原生把每一条 turn/start 都算进目录，
// 装上游 tavern 的裁剪后，正文已经没有节点的轮次不再出现；卸载后回到原生输出。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installHostTurnRailFilter } from '../tavern-plugin/lib/domain/host-turn-rail.js'

const native = { skip: !process.env.DSH_BOOT_MODULE }

async function harness(t) {
  const url = pathToFileURL(process.env.DSH_BOOT_MODULE)
  const { boot } = await import(url)
  const sessionModule = await import(new URL('../../dsh-session/lib/index.js', url).href)
  const root = await mkdtemp(join(tmpdir(), 'tavern-turn-rail-'))
  const config = join(root, 'host.yml')
  await writeFile(config, ['dsh-session', 'dsh-session-projection', 'dsh-session-turn-outline'].map(n => '- name: ' + new URL('../../' + n + '/lib/index.js', url).href).join('\n'))
  const ctx = await boot('tavern-turn-rail-test', config)
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  return { registry: ctx.sessionProjections, Session: sessionModule.Session }
}

const message = (role, text) => ({ id: String(Math.random()).slice(2), role, content: [{ type: 'text', text }], source: { kind: role === 'user' ? 'user' : 'model', provider: 'fixture', model: 'fixture' } })

// 三轮。第 2 轮整段（输入与正文）被后来的空标记盖掉，和 tavern 清理失败/尝试轮的做法一样。
function threeTurns(Session) {
  const session = Session.create('tavern-turn-rail-fixture', undefined, { id: 'tavern-turn-rail-fixture', version: 4, createdAt: 0, isSeeded: false, delegationDepth: 0 })
  let retried = null
  for (const turn of [1, 2, 3]) {
    session.append('turn/start', { turn })
    const input = session.append('user/message', { id: 'user-' + turn, role: 'user', content: [{ type: 'text', text: '第 ' + turn + ' 轮' }], source: { kind: 'user' }, turn, step: 1 }, { surfaceOp: 'append' })
    const reply = session.append('assistant/message', { turn, step: 1, stream: [], message: message('assistant', '第 ' + turn + ' 轮正文') }, { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    if (turn === 2) retried = { input, reply }
  }
  const start = retried.input.seq
  const end = retried.reply.seq
  session.append('user/message', { id: 'cleanup', role: 'user', content: [], source: { kind: 'plugin:fixture-cleanup' } }, {
    surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
    sourceEventSeqs: Array.from({ length: end - start + 1 }, (item, index) => start + index),
  })
  return session
}

test('原生目录收录重试留下的空轮次，裁剪后只剩表面还有内容的轮次', native, async t => {
  const { registry, Session } = await harness(t)
  const session = threeTurns(Session)
  const outline = () => registry.snapshot(session).values.turnOutline.map(entry => entry.turn)
  assert.deepEqual(outline(), [1, 2, 3], '原生：一条 turn/start 一个刻度')
  const dispose = installHostTurnRailFilter(registry)
  assert.deepEqual(outline(), [1, 3], '第 2 轮正文已被盖掉，跳过去没有内容')
  assert.deepEqual(registry.cachedSnapshot(session).values.turnOutline.map(entry => entry.turn), [1, 3])
  dispose()
  assert.deepEqual(outline(), [1, 2, 3], '卸载后回到原生目录')
})

test('变更推送也裁：新的一轮还没有正文时，它的输入已经算数', native, async t => {
  const { registry, Session } = await harness(t)
  const session = threeTurns(Session)
  session.append('turn/start', { turn: 4 })
  session.append('user/message', { id: 'user-4', role: 'user', content: [{ type: 'text', text: '第 4 轮' }], source: { kind: 'user' }, turn: 4, step: 1 }, { surfaceOp: 'append' })
  const frames = []
  const dispose = installHostTurnRailFilter(registry)
  const off = registry.onChanged((current, key, value) => { if (key === 'turnOutline') frames.push(value.map(entry => entry.turn)) })
  for (const event of session.snapshotEvents()) registry.drive(session, event)
  assert.ok(frames.length > 0, '推送确实发生')
  assert.ok(frames.at(-1).includes(4), '正在进行的第 4 轮留在目录里：' + JSON.stringify(frames.at(-1)))
  assert.ok(frames.every(entry => !entry.includes(2)), '被盖掉的第 2 轮始终不出现：' + JSON.stringify(frames))
  off()
  dispose()
})
