import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { chromium } from 'playwright'

const instance = process.env.TAVERN_E2E_INSTANCE
if (!instance || !isAbsolute(instance) || !instance.includes('/.artifacts/sidebar-rc2-')) throw new Error('必须指定Tasks隔离实例')
const port = process.env.TAVERN_E2E_PORT || '3194'
const output = join(instance, '../browser', String(Date.now()))
await mkdir(output, { recursive: true })
const log = await readFile(join(instance, 'dsh.log'), 'utf8')
const entry = (log.match(/http:\/\/[^\s\x1b"'<>]+/g) || []).findLast(value => {
  const url = new URL(value)
  return url.hostname === '127.0.0.1' && url.port === port && url.searchParams.has('token')
})
assert.ok(entry, '缺少隔离宿主入口')
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell') })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
page.setDefaultTimeout(20000)
const report = { steps: [], errors: [] }
const redact = value => String(value).replace(/token=[^\s&"']+/g, 'token=[redacted]')
page.on('pageerror', error => report.errors.push(redact(error.message)))
page.on('console', message => { if (message.type() === 'error' && /slot entry crashed|Cannot read properties/.test(message.text())) report.errors.push(redact(message.text())) })
const post = (path, body) => page.evaluate(async ({ path, body }) => {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}, { path, body })
const fixture = async body => {
  const response = await post('/sidebar-fixture', body)
  assert.equal(response.status, 200, JSON.stringify(response.body))
  return response.body
}
const board = page.locator('[data-team-board]')
const open = async id => {
  await page.waitForFunction(id => Boolean(window.sidebarTeamFixture.snapshot().byId[id]), id)
  await page.evaluate(id => window.sidebarTeamFixture.open(id), id)
  await page.evaluate(() => window.sidebarTeamFixture.tasks())
}
const taskState = async (id, expected) => {
  await page.waitForFunction(({ id, expected }) => {
    const task = window.sidebarTeamFixture.snapshot().projectionsBySession[id]?.values.agentTeam?.tasks[0]
    return task && Object.entries(expected).every(([key, value]) => task[key] === value)
  }, { id, expected })
  return page.evaluate(id => window.sidebarTeamFixture.snapshot().projectionsBySession[id].values.agentTeam.tasks[0], id)
}
let failure
try {
  await page.goto(entry)
  const welcome = page.locator('.dshpp-welcome-mask')
  await page.addLocatorHandler(welcome, async () => {
    await welcome.getByRole('checkbox').check()
    await welcome.getByRole('button', { name: /I understand|我已了解|我已知晓|我已阅读/ }).click()
  })
  await page.addLocatorHandler(page.getByText(/^(Preview Notice|预览版.*说明)$/), async () => {
    if (await welcome.isVisible()) {
      await welcome.getByRole('checkbox').check()
      await welcome.getByRole('button', { name: /I understand|我已了解|我已知晓|我已阅读/ }).click()
    }
    await page.getByRole('button', { name: /^(Continue|继续)$/ }).click()
  })
  await page.waitForFunction(() => Boolean(window.sidebarTeamFixture))
  const disabled = await fixture({ action: 'create', enabled: false })
  await open(disabled.id)
  await page.getByText(/^(暂无子代理|No subagents)$/).waitFor()
  assert.equal(await board.count(), 0)
  assert.deepEqual(report.errors, [])
  report.steps.push('无团队会话打开Tasks无异常，团队板隐藏')

  const root = await fixture({ action: 'create', enabled: true })
  await open(root.id)
  await board.waitFor()
  await board.getByRole('button', { name: /^(新建任务|New task)$/ }).click()
  await page.getByPlaceholder(/一句话说明要做什么|One line describing the work/).fill('侧栏任务验收')
  await page.getByRole('textbox', { name: /^(描述|Description)$/ }).fill('真实rc.2任务存储')
  await page.getByRole('button', { name: /^(新建任务|New task)$/ }).last().click()
  let task = await taskState(root.id, { subject: '侧栏任务验收', status: 'pending' })
  report.steps.push('启用空团队显示lead，浏览器新建任务并收到真实投影')
  const children = await fixture({ action: 'children', id: root.id })
  await board.getByRole('button', { name: 'alpha/worker', exact: true }).waitFor()
  await board.getByRole('button', { name: /^(任务详情|Task detail) 侧栏任务验收$/ }).click()
  const owners = page.getByRole('group', { name: /^(负责人|Owner)$/ })
  await owners.getByRole('button', { name: 'alpha/worker', exact: true }).click()
  task = await taskState(root.id, { ownerId: children.nested, status: 'in_progress' })
  assert.equal(task.ownerName, 'alpha/worker')
  report.steps.push('真实两层子代理展示完整路径，浏览器按session ID分配嵌套成员')
  await page.getByRole('button', { name: /^(编辑|Edit)$/ }).last().click()
  await page.getByPlaceholder(/一句话说明要做什么|One line describing the work/).fill('侧栏任务已编辑')
  await page.getByRole('button', { name: /^(保存|Save)$/ }).last().click()
  task = await taskState(root.id, { subject: '侧栏任务已编辑' })
  await page.getByRole('button', { name: /^(完成|Complete)$/ }).last().click()
  task = await taskState(root.id, { status: 'completed' })
  assert.equal(await owners.getByRole('button', { name: 'beta', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: /^(重开|Reopen)$/ }).last().click()
  task = await taskState(root.id, { status: 'pending' })
  await page.getByRole('button', { name: /^(认领|Claim)$/ }).last().click()
  task = await taskState(root.id, { status: 'in_progress', ownerId: root.id })
  report.steps.push('编辑、完成、重开和lead认领成功；已完成任务不可重新分配')

  const conflict = await post('/sidebar/api/teams.taskUpdate', { rootSessionId: root.id, taskId: task.id, expectedRevision: task.revision - 1, action: 'complete' })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'team-conflict')
  const foreign = await post('/sidebar/api/teams.taskUpdate', { rootSessionId: root.id, taskId: task.id, expectedRevision: task.revision, action: 'reassign', owner: disabled.id })
  assert.equal(foreign.status, 400)
  await owners.getByRole('button', { name: /^(未认领|Unclaimed)$/ }).click()
  task = await taskState(root.id, { status: 'pending' })
  assert.equal(task.ownerId, undefined)
  report.steps.push('真实HTTP拒绝陈旧版本及树外分配；取消负责人恢复待办')

  await page.keyboard.press('Escape')
  await fixture({ action: 'mode', id: root.id, enabled: false })
  await board.waitFor({ state: 'hidden' })
  const rejected = await post('/sidebar/api/teams.taskCreate', { rootSessionId: root.id, subject: '不可写', description: '不可写' })
  assert.equal(rejected.status, 400)
  await fixture({ action: 'mode', id: root.id, enabled: true })
  await board.waitFor()
  task = await taskState(root.id, { subject: '侧栏任务已编辑' })
  report.steps.push('禁用团队隐藏保留任务并拒绝写入，重新启用后任务仍在')

  await page.reload()
  await page.waitForFunction(() => Boolean(window.sidebarTeamFixture))
  await open(root.id)
  await board.getByRole('button', { name: /^(任务详情|Task detail) 侧栏任务已编辑$/ }).waitFor()
  await board.getByRole('button', { name: 'alpha/worker', exact: true }).waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  const back = page.getByRole('button', { name: /回到故事/ })
  if (await back.isVisible()) await back.click()
  await page.evaluate(() => window.sidebarTeamFixture.tasks())
  await board.waitFor()
  await page.waitForFunction(() => {
    const rect = document.querySelector('[data-team-board]')?.getBoundingClientRect()
    return rect && rect.x >= 0 && rect.right <= 391 && rect.width > 250
  })
  await board.getByRole('button', { name: /^(任务详情|Task detail) 侧栏任务已编辑$/ }).click()
  await page.keyboard.press('Escape')
  await page.screenshot({ path: join(output, 'mobile.png') })
  report.steps.push('重新加载保留任务；390宽度Tasks与成员展示正常')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await board.getByRole('button', { name: /^(任务详情|Task detail) 侧栏任务已编辑$/ }).click()
  await page.getByRole('button', { name: /^(删除|Delete)$/ }).last().click()
  await page.getByRole('button', { name: /^(确认删除|Confirm delete)$/ }).last().click()
  await board.getByText(/^(暂无共享任务|No shared tasks yet)$/).waitFor()
  report.steps.push('两步确认删除成功，任务板收到删除后的投影')

  const create = async subject => {
    const response = await post('/sidebar/api/teams.taskCreate', { rootSessionId: root.id, subject, description: '合成依赖链' })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    return response.body.value.value
  }
  const update = async (value, action, fields = {}) => {
    const response = await post('/sidebar/api/teams.taskUpdate', { rootSessionId: root.id, taskId: value.id, expectedRevision: value.revision, action, ...fields })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    return response.body.value.value
  }
  let blocker = await create('前置任务')
  let dependent = await create('依赖任务')
  dependent = await update(dependent, 'set_dependencies', { blockedBy: [blocker.id] })
  const blocked = await post('/sidebar/api/teams.taskUpdate', { rootSessionId: root.id, taskId: dependent.id, expectedRevision: dependent.revision, action: 'claim' })
  assert.equal(blocked.status, 400)
  blocker = await update(blocker, 'claim')
  blocker = await update(blocker, 'release')
  blocker = await update(blocker, 'claim')
  await update(blocker, 'complete')
  dependent = await update(dependent, 'claim')
  assert.equal(dependent.status, 'in_progress')
  report.steps.push('真实依赖更新、阻塞拒绝、释放、完成前置及解锁认领通过')
  const cold = await fixture({ action: 'cold', id: root.id })
  assert.equal(cold.cold, true)
  const resumed = await create('冷会话写入恢复')
  assert.equal(resumed.subject, '冷会话写入恢复')
  report.steps.push('冷根会话经公开控制器恢复后可写，原任务保持')
  assert.deepEqual(report.errors, [])
  report.status = 'passed'
} catch (error) {
  failure = error
  report.status = 'failed'
  report.error = redact(error.message)
  report.text = await page.locator('body').innerText().catch(() => '')
  await page.screenshot({ path: join(output, 'failed.png') }).catch(() => {})
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
  await browser.close()
}
console.log(JSON.stringify({ output, ...report }))
if (failure) process.exitCode = 1
