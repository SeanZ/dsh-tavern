import test from 'node:test'
import assert from 'node:assert/strict'
import { assertInstallationIdle, installationProcessInventory } from '../tavern-plugin/packages/dsh-profile-bridge/lib/installation-processes.mjs'
const request = { home: '/home/me/.dsh', installation: { appDir: '/home/me/.dsh/apps/dsh-tavern', entries: [{ from: '/home/me/.dsh/profile-data/tavern', to: '/mnt/tavern/data' }] } }
const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }
const row = (pid, commandLine, name = 'node') => ({ pid, commandLine, name })
const options = rows => ({ selfPid: 10, platform: 'linux', read: missing, cwd: () => '/unrelated', inventory: async () => ({ rows }) })

test('independent Tavern runtime, relocated paths, shared home and Desktop GUI block without killing', async () => {
  for (const process of [row(20, 'node /home/me/.dsh/apps/dsh-tavern/bin/dsh-tavern.mjs'), row(20, 'node server.js --data /mnt/tavern/data'), row(20, 'node service.js --home /home/me/.dsh'), row(20, '"/opt/DeepSeek Harness" --expose-internals', 'DeepSeek Harness'), row(20, 'dsh web --profile tavern', 'dsh')]) {
    await assert.rejects(assertInstallationIdle(request, options([row(10, 'node worker.mjs'), process])), /未结束任何进程/)
  }
})
test('worker and inspector are excluded by PID, not command-string content', async () => {
  const rows = [row(10, 'node /home/me/.dsh/profile-bridge/worker.mjs'), row(30, 'node /home/me/.dsh/inspect'), row(40, 'node /unrelated/api.mjs')]
  assert.deepEqual(await assertInstallationIdle(request, { ...options(rows), inventory: async () => ({ inspectorPid: 30, rows }) }), { idle: true })
  await assert.rejects(assertInstallationIdle(request, options([...rows, row(50, 'node /home/me/.dsh/inspect')])), /PID 30/)
})
test('live or ambiguous service PID refuses; stale service PID is harmless', async () => {
  const base = options([row(10, 'node worker.mjs')])
  await assert.rejects(assertInstallationIdle(request, { ...base, read: () => '{"pid":90}', alive: () => true }), /PID 90/)
  assert.deepEqual(await assertInstallationIdle(request, { ...base, read: () => '{"pid":90}', alive: () => false }), { idle: true })
  for (const content of ['bad json', '{}', '{"pid":0}']) await assert.rejects(assertInstallationIdle(request, { ...base, read: () => content }), /无法确认/)
})
test('inventory errors, malformed snapshots and hidden runtime arguments fail closed', async () => {
  const base = options([row(10, 'node worker.mjs')])
  for (const inventory of [async () => { throw Error('CIM denied') }, async () => ({}), async () => ({ rows: [] }), async () => ({ rows: [{ pid: '20' }] }), async () => ({ rows: [row(20, null)] })]) {
    await assert.rejects(assertInstallationIdle(request, { ...base, inventory }), /清单|参数/)
  }
})
test('runtime cwd inside installation blocks even when command is relative', async () => {
  await assert.rejects(assertInstallationIdle(request, { ...options([row(20, 'node server.js')]), cwd: () => '/mnt/tavern/data' }), /PID 20/)
  await assert.rejects(assertInstallationIdle(request, { ...options([row(20, 'node server.js')]), cwd: () => { throw Object.assign(Error('denied'), { code: 'EACCES' }) } }), /工作目录/)
})
test('Windows matching normalizes case and separators; inaccessible node command refuses', async () => {
  const win = { home: 'C:\\Users\\Me\\.dsh', installation: { appDir: 'D:\\Tavern\\app' } }
  await assert.rejects(assertInstallationIdle(win, { ...options([row(20, 'node D:/TAVERN/app/server.js', 'node.exe')]), platform: 'win32' }), /PID 20/)
  await assert.rejects(assertInstallationIdle(win, { ...options([row(20, null, 'node.exe')]), platform: 'win32' }), /参数/)
})
test('inventory adapters use bounded read-only ps/CIM and parse PID-aware output', async () => {
  const calls = []
  const run = async (...args) => { calls.push(args); return { stdout: ' 10 node worker.mjs\n 20 node service.mjs\n' } }
  assert.equal((await installationProcessInventory({ platform: 'linux', run })).rows.length, 2)
  assert.deepEqual(calls[0][1], ['-axo', 'pid=,args='])
  const win = await installationProcessInventory({ platform: 'win32', run: async (exe, args) => {
    assert.equal(exe, 'powershell.exe'); assert.match(args.at(-1), /Get-CimInstance/); assert.doesNotMatch(args.at(-1), /Stop-Process|TerminateProcess/)
    return { stdout: '{"inspectorPid":99,"rows":[{"pid":10,"name":"node.exe","commandLine":"node worker"}]}' }
  } })
  assert.equal(win.inspectorPid, 99)
})

test('shell scripts containing source text and unrelated node test runners are not DSH consumers', async () => {
  const rows = [
    row(10, 'node worker.mjs'),
    row(20, `bash -c "cat > module.mjs <<EOF\nconst gui = /DeepSeek Harness/; const args = 'node /home/me/.dsh/app';\nEOF"`, 'bash'),
    row(30, 'node --test /workspace/dsh-tavern/tests/profile-bridge-installation.test.mjs'),
    row(40, 'node /workspace/dsh-tavern/scripts/dev-check.mjs'),
    row(50, 'sh -c "node /workspace/dsh-tavern/bin/dsh-tavern.mjs"', 'sh'),
  ]
  assert.deepEqual(await assertInstallationIdle(request, options(rows)), { idle: true })
})
test('actual source entrypoint and a node test process inside the managed installation remain blocked', async () => {
  for (const command of ['node /workspace/dsh-tavern/bin/dsh-tavern.mjs start', 'node /opt/dsh-desktop-host/index.mjs', 'node --test /home/me/.dsh/apps/dsh-tavern/tests/check.mjs']) {
    await assert.rejects(assertInstallationIdle(request, options([row(20, command)])), /PID 20/)
  }
})
