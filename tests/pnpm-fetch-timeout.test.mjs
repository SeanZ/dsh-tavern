import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Like pnpm-install-exit.test.mjs, opt in with a real installed pnpm entry.
// The registry and tarball are local; each case has a fresh home and store.
const entry = process.env.TAVERN_PNPM_ENTRY
const installer = await readFile(new URL('../android/install.sh', import.meta.url), 'utf8')
const start = installer.indexOf('export pnpm_config_reporter=')
const end = installer.indexOf('# 缓存命中时先跑一遍', start)
assert.ok(start >= 0 && end > start, 'installer pnpm setup must be present')
const setup = installer.slice(start, end)
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const shellPath = value => value.replaceAll('\\', '/')

for (const timeout of ['', '600000', '180000']) {
  test(`real installer pnpm wrapper fetches with ${timeout || 'default'} timeout and supports config`, { skip: !entry }, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'tavern-pnpm-timeout-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const fixture = path.join(root, 'fixture', 'package')
    await mkdir(fixture, { recursive: true })
    await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'tavern-timeout-fixture', version: '1.0.0' }))
    const archive = path.join(root, 'fixture.tgz')
    const packed = spawnSync('tar', ['-czf', archive, '-C', path.dirname(fixture), 'package'], { encoding: 'utf8' })
    assert.equal(packed.status, 0, packed.stderr || packed.error?.message)
    const bytes = await readFile(archive)
    const requests = []
    const server = createServer((req, res) => {
      requests.push(req.url)
      if (req.url === '/fixture.tgz') { res.end(bytes); return }
      if (req.url !== '/tavern-timeout-fixture') { res.writeHead(404); res.end(); return }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        name: 'tavern-timeout-fixture', 'dist-tags': { latest: '1.0.0' },
        time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
        versions: { '1.0.0': { name: 'tavern-timeout-fixture', version: '1.0.0', dist: {
          tarball: `http://127.0.0.1:${server.address().port}/fixture.tgz`,
          integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
        } } },
      }))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
    const project = path.join(root, 'project')
    const home = path.join(root, 'home')
    await mkdir(project)
    await mkdir(home)
    await writeFile(path.join(project, 'package.json'), JSON.stringify({
      name: 'timeout-test', version: '1.0.0', dependencies: { 'tavern-timeout-fixture': '1.0.0' },
    }))
    // Observe the actual numeric value passed to Node. On a type error, fail
    // immediately: pnpm's async fetch rejection can otherwise remain pending.
    const trace = path.join(root, 'trace.mjs')
    await writeFile(trace, `const original = AbortSignal.timeout.bind(AbortSignal)
AbortSignal.timeout = function(delay) {
  process.stderr.write('TIMEOUT_TYPE ' + typeof delay + ' ' + delay + '\\n')
  try { return original(delay) }
  catch (error) { process.stderr.write(error.stack + '\\n'); process.exit(1) }
}
`)
    const shim = path.join(root, 'pnpm')
    const runtime = process.env.TAVERN_PNPM_RUNTIME || process.execPath
    await writeFile(shim, '#!/usr/bin/env bash\nexec ' +
      [shellPath(runtime), '--import', pathToFileURL(trace).href, shellPath(path.resolve(entry))].map(shellQuote).join(' ') + ' "$@"\n', { mode: 0o755 })
    const script = path.join(root, 'run.sh')
    await writeFile(script, 'set -euo pipefail\nPNPM_COMMAND=' + shellQuote(shellPath(shim)) + '\n' + setup +
      '\npnpm config set package-import-method copy --location=user\n' +
      'pnpm config get package-import-method\n' +
      'pnpm --dir ' + shellQuote(shellPath(project)) + ' install --ignore-scripts --lockfile=false --config.minimum-release-age=0' +
      ' --store-dir=' + shellQuote(shellPath(path.join(root, 'store'))) +
      ' --registry=http://127.0.0.1:' + server.address().port + ' --fetch-retries=0\n')
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (/^(npm|pnpm)_config_/i.test(key) || /^(http|https|all|no)_proxy$/i.test(key) || key === 'NODE_OPTIONS') delete env[key]
    }
    Object.assign(env, {
      HOME: shellPath(home), USERPROFILE: home, XDG_CONFIG_HOME: shellPath(path.join(home, 'config')),
      XDG_CACHE_HOME: shellPath(path.join(home, 'cache')), CI: 'true', pnpm_config_fetch_timeout: timeout,
    })
    if (process.env.TAVERN_PNPM_RUNTIME) env.ELECTRON_RUN_AS_NODE = '1'
    const child = spawn(process.env.TEST_BASH || 'bash', [shellPath(script)], { env, cwd: root })
    let output = '', timedOut = false
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 15000)
    t.after(() => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    clearTimeout(timer)
    assert.equal(timedOut, false, output)
    assert.equal(code, 0, output)
    assert.match(output, /copy/)
    assert.match(output, /Done in/)
    assert.match(output, new RegExp('TIMEOUT_TYPE number ' + (timeout || '600000') + '(?:\\r?\\n)'))
    assert.doesNotMatch(output, /TIMEOUT_TYPE string|ERR_INVALID_ARG_TYPE/)
    assert.ok(requests.includes('/tavern-timeout-fixture'), JSON.stringify(requests))
    assert.ok(requests.includes('/fixture.tgz'), JSON.stringify(requests))
    const installed = JSON.parse(await readFile(path.join(project, 'node_modules', 'tavern-timeout-fixture', 'package.json'), 'utf8'))
    assert.equal(installed.version, '1.0.0')
  })
}
