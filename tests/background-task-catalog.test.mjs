import assert from 'node:assert/strict'
import test from 'node:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { BACKGROUND_TASK_CATALOG, describeTasks } from '../tavern-plugin/lib/domain/background-task-catalog.js'

async function sources(dir) {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'client.js') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await sources(path))
    else if (entry.name.endsWith('.js')) files.push(path)
  }
  return files
}

test('every background task kind the code runs is listed in the catalog', async () => {
  const listed = new Set(BACKGROUND_TASK_CATALOG.map(item => item.task))
  const used = new Set()
  for (const file of await sources(new URL('../tavern-plugin/lib', import.meta.url).pathname)) {
    for (const match of (await readFile(file, 'utf8')).matchAll(/\btask: *'([a-z-]+)'/g)) used.add(match[1])
  }
  // Sub-agents the foreground spawns are not background runner tasks.
  used.delete('subagent')
  assert.ok(used.size >= 8)
  assert.deepEqual([...used].filter(task => !listed.has(task)), [])
  for (const item of BACKGROUND_TASK_CATALOG) {
    assert.ok(item.name && item.does && item.manual && ['resident', 'ephemeral'].includes(item.lane), item.task)
    for (const task of item.needs || []) assert.ok(listed.has(task), item.task + ' needs ' + task)
  }
})

test('the page lines are written from the declarations: starting moments, needs and what waits', () => {
  const jobs = [{ task: 'settlement', on: ['reply-committed'], cancelOn: [], condition: '', flow: true }, { task: 'polish', on: ['reply-committed', 'turn-settled'], cancelOn: [], condition: '开启自动精修时' },
    { task: 'stage-director', on: ['reply-committed'], cancelOn: ['turn-discarded'], condition: '' }]
  const names = { 'reply-committed': '正文写完', 'turn-settled': '本轮结算完', 'turn-discarded': '回合作废' }
  const lines = Object.fromEntries(describeTasks(BACKGROUND_TASK_CATALOG, jobs, event => names[event]).map(item => [item.task, item]))
  assert.equal(lines.polish.trigger, '正文写完、本轮结算完（开启自动精修时）；点「精修」。')
  assert.match(lines['stage-director'].waits, /^回合作废时取消；/)
  assert.equal(lines.settlement.trigger, '正文写完，由流程直接启动并等它的结果；重新生成后也由流程启动；失败可在酒馆状态里重试。')
  assert.equal(lines.candidate.waits, '等变量结算完成')
  assert.equal(lines.settlement.waits, '下一轮开始前要等它；生成选项要等它完成')
  assert.equal(lines.phone.waits, '不等其他任务')
  assert.equal(lines.plugin.waits, '前台不在生成时才能开始；下一轮开始前要等它')
  const plugin = describeTasks([{ task: 'plugin:x:y', name: 'y', trigger: '自己的', waits: '' }], [])[0]
  assert.equal(plugin.trigger, '自己的')
})
