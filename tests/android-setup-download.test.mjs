import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))
const bash = process.env.TEST_BASH || 'bash'
const shellPath = value => value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)

for (const failures of [0, 1, 3]) {
  test(`setup downloads with ${failures} interrupted Git attempts`, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'android-setup-download-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const fixture = path.join(directory, 'source')
    const mock = path.join(directory, 'mock')
    await mkdir(path.join(fixture, 'android'), { recursive: true })
    await mkdir(path.join(fixture, 'bin'))
    await mkdir(mock)
    await writeFile(path.join(fixture, '.gitattributes'), await readFile(path.join(root, '.gitattributes')))
    await writeFile(path.join(fixture, 'package.json'), '{}')
    await writeFile(path.join(fixture, 'bin/dsh-tavern.mjs'), '')
    await writeFile(path.join(fixture, 'android/install.sh'), '#!/usr/bin/env bash\ntouch "${DSH_HOME}/installed"\n')
    const archive = path.join(directory, 'source.tar.gz')
    for (const args of [
      ['init', '-b', 'main'], ['add', '.'],
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture'],
      ['archive', '--format=tar.gz', '--prefix=source/', '-o', archive, 'HEAD'],
    ]) {
      const result = spawnSync('git', args, { cwd: fixture, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    await writeFile(path.join(mock, 'git'), `#!/usr/bin/env bash
set -eu
# 传输超时参数（-c http.lowSpeed*）会出现在 clone 之前，按子命令判断。
if [[ " $* " != *" clone "* ]]; then exit 0; fi
count=0
[ ! -f "$TEST_ROOT/attempts" ] || count=$(cat "$TEST_ROOT/attempts")
count=$((count + 1))
echo "$count" > "$TEST_ROOT/attempts"
destination="\${@: -1}"
[ ! -e "$destination" ] || exit 90
mkdir -p "$destination"
if [ "$count" -le "${failures}" ]; then
  touch "$destination/partial"
  exit 1
fi
cp -R "$TEST_ROOT/source/." "$destination/"
`, { mode: 0o755 })
    const result = spawnSync(bash, ['-c', 'export PATH="$TEST_ROOT/mock:$PATH"; exec bash "$TEST_SETUP"'], {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, TEST_ROOT: shellPath(directory), TEST_SETUP: shellPath(path.join(root, 'android/setup.sh')),
        DSH_HOME: shellPath(path.join(directory, 'home')), DSH_TAVERN_REPOSITORY: 'test-repository', DSH_TAVERN_BRANCH: 'main',
        DSH_TAVERN_TARBALL_URL: pathToFileURL(archive).href },
    })
    assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`)
    assert.equal(await readFile(path.join(directory, 'attempts'), 'utf8'), `${Math.min(failures + 1, 3)}\n`)
    await readFile(path.join(directory, 'home/installed'))
    if (failures === 3) assert.match(result.stdout, /改用 GitHub 压缩包/)
    else assert.doesNotMatch(result.stdout, /改用 GitHub 压缩包/)
  })
}

// Exercise the real source-selection function only: Git and tarball downloads are
// shell functions that record their arguments. No installer or network command runs.
async function probeUpdateSource(t, { origin, marker, repository = '', tarballUrl = '', branch = 'main' }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'android-update-source-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const app = path.join(directory, 'app')
  await mkdir(app)
  if (origin !== undefined) await mkdir(path.join(app, '.git'))
  if (marker !== undefined) await writeFile(path.join(app, '.dsh-tavern-tarball-source'), marker + '\n')
  const source = (await readFile(path.join(root, 'android/setup.sh'), 'utf8')).replaceAll('\r\n', '\n')
  const declarations = source.slice(source.indexOf('DSH_ROOT='), source.indexOf('\nfail() {'))
  const updateSource = source.slice(source.indexOf('update_source() {'), source.indexOf('\n# 恢复模式：'))
  assert.ok(declarations.includes('DEFAULT_REPOSITORY='))
  assert.ok(updateSource.includes('update_source() {') && updateSource.includes('SOURCE_MARKER'))
  await writeFile(path.join(directory, 'probe.sh'), `#!/usr/bin/env bash
set -euo pipefail
${declarations}
fail() { printf '%s\\n' "$1" >&2; exit 1; }
require_command() { [ "$1" = git ]; }
git() {
  while [ "$#" -gt 0 ]; do
    case "$1" in -C|-c) shift 2 ;; *) break ;; esac
  done
  case "$1" in
    remote)
      case "$2" in
        get-url) [ -n "$TEST_ORIGIN" ] || return 2; printf '%s\\n' "$TEST_ORIGIN" ;;
        set-url) TEST_ORIGIN="$4"; printf 'remote %s\\n' "$TEST_ORIGIN" >> "$TEST_ROOT/actions" ;;
        *) return 99 ;;
      esac
      ;;
    fetch) [ -n "$TEST_ORIGIN" ] || return 2; printf 'fetch %s %s\\n' "$TEST_ORIGIN" "$3" >> "$TEST_ROOT/actions" ;;
    merge) printf 'merge %s\\n' "$3" >> "$TEST_ROOT/actions" ;;
    diff|config|sparse-checkout|merge-base) : ;;
    *) printf 'Unexpected git command: %s\\n' "$*" >&2; return 99 ;;
  esac
}
install_from_tarball() { printf 'tarball %s\\n' "$TARBALL_URL" >> "$TEST_ROOT/actions"; }
install_from_cdn() { return 99; }
${updateSource}
update_source
`)
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^DSH_TAVERN_/i.test(key)))
  const result = spawnSync(bash, ['-c', 'source "$TEST_ROOT/probe.sh"'], {
    encoding: 'utf8', timeout: 10000,
    env: { ...inherited, TEST_ROOT: shellPath(directory), TEST_ORIGIN: origin || '',
      DSH_HOME: shellPath(path.join(directory, 'home')), DSH_TAVERN_ANDROID_APP_DIR: shellPath(app),
      DSH_TAVERN_REPOSITORY: repository, DSH_TAVERN_TARBALL_URL: tarballUrl, DSH_TAVERN_BRANCH: branch },
  })
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`)
  return (await readFile(path.join(directory, 'actions'), 'utf8')).trim().split('\n')
}

const migratedRepository = 'https://github.com/koabop/dsh-tavern.git'
for (const origin of [
  'https://github.com/flizzywine/dsh-tavern.git',
  'https://github.com/flizzywine/dsh-tavern',
  'http://github.com/flizzywine/dsh-tavern.git',
  'git://github.com/flizzywine/dsh-tavern.git',
  'git@github.com:flizzywine/dsh-tavern.git',
  'ssh://git@github.com/flizzywine/dsh-tavern.git',
]) {
  test(`Android update migrates the legacy origin without changing its branch: ${origin}`, async t => {
    const actions = await probeUpdateSource(t, { origin, branch: 'stable' })
    assert.deepEqual(actions, [`remote ${migratedRepository}`, `fetch ${migratedRepository} stable`, 'merge origin/stable'])
  })
}

for (const origin of [
  migratedRepository,
  'https://github.com/custom/dsh-tavern.git',
  'https://github.com/flizzywine/dsh-tavern-custom.git',
  'https://github.com.example/flizzywine/dsh-tavern.git',
  '/local/flizzywine/dsh-tavern.git',
]) {
  test(`Android update preserves an already migrated or custom origin: ${origin}`, async t => {
    assert.deepEqual(await probeUpdateSource(t, { origin }), [`fetch ${origin} main`, 'merge origin/main'])
  })
}

test('Android update honours an explicit repository override even for an existing custom origin', async t => {
  const repository = 'https://github.com/another/custom-tavern.git'
  assert.deepEqual(await probeUpdateSource(t, { origin: 'https://github.com/custom/dsh-tavern.git', repository }),
    [`remote ${repository}`, `fetch ${repository} main`, 'merge origin/main'])
})

const legacyTarballRoot = 'https://codeload.github.com/flizzywine/dsh-tavern/'
const migratedTarballRoot = 'https://codeload.github.com/koabop/dsh-tavern/'
for (const suffix of ['tar.gz/refs/heads/main', 'tar.gz/refs/heads/stable', `tar.gz/${'a'.repeat(40)}`]) {
  test(`Android update migrates the legacy tarball marker and preserves its exact ref: ${suffix}`, async t => {
    assert.deepEqual(await probeUpdateSource(t, { marker: legacyTarballRoot + suffix }), ['tarball ' + migratedTarballRoot + suffix])
  })
}

for (const marker of [
  migratedTarballRoot + 'tar.gz/refs/heads/main',
  'file:///local/flizzywine/dsh-tavern.tar.gz',
  'https://codeload.github.com/custom/dsh-tavern/tar.gz/refs/heads/stable',
  'https://codeload.github.com/flizzywine/dsh-tavern-custom/tar.gz/refs/heads/main',
  'https://codeload.github.com.example/flizzywine/dsh-tavern/tar.gz/refs/heads/main',
]) {
  test(`Android update preserves a custom or already migrated tarball marker: ${marker}`, async t => {
    assert.deepEqual(await probeUpdateSource(t, { marker }), ['tarball ' + marker])
  })
}

for (const tarballUrl of ['file:///local/override.tar.gz', legacyTarballRoot + 'tar.gz/refs/heads/stable']) {
  test(`Android update keeps the explicit tarball override authoritative: ${tarballUrl}`, async t => {
    assert.deepEqual(await probeUpdateSource(t, { marker: legacyTarballRoot + 'tar.gz/refs/heads/main', tarballUrl }), ['tarball ' + tarballUrl])
  })
}

test('Android update falls back to the migrated default for an empty tarball marker', async t => {
  assert.deepEqual(await probeUpdateSource(t, { marker: '' }), ['tarball ' + migratedTarballRoot + 'tar.gz/refs/heads/main'])
})

for (const repository of ['', 'https://github.com/custom/dsh-tavern.git']) {
  test(`Android update still falls back to a tarball when origin is missing (override: ${repository || 'none'})`, async t => {
    assert.deepEqual(await probeUpdateSource(t, { origin: '', repository }), ['tarball ' + migratedTarballRoot + 'tar.gz/refs/heads/main'])
  })
}
