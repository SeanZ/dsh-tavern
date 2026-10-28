import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { recordInstalledRelease } from '../bin/profile-installation.mjs'

const REVISION = 'a'.repeat(40)
const RELEASE_FILE = '.dsh-tavern-release.json'

async function fixture(t, manifest) {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-release-record-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceRoot = path.join(root, 'source')
  await mkdir(sourceRoot, { recursive: true })
  if (manifest !== null) await writeFile(path.join(sourceRoot, 'dsh-tavern-runtime.json'), manifest)
  return { sourceRoot, dshRoot: path.join(root, 'home') }
}

test('压缩包安装没有网络时，用源码自带运行清单记下提交号', async (t) => {
  const { sourceRoot, dshRoot } = await fixture(t, JSON.stringify({ revision: REVISION, releaseSequence: 911 }))
  const offline = async () => { throw new Error('网络不可用') }
  const release = await recordInstalledRelease({ sourceRoot, dshRoot, request: offline })
  assert.equal(release.commit, REVISION)
  const written = JSON.parse(await readFile(path.join(sourceRoot, RELEASE_FILE), 'utf8'))
  assert.equal(written.commit, REVISION)
  assert.ok(written.installedAt)
})

test('清单缺失时才走网络，并把拿到的提交号写进安装记录', async (t) => {
  const { sourceRoot, dshRoot } = await fixture(t, null)
  const upstream = 'c'.repeat(40)
  const release = await recordInstalledRelease({
    sourceRoot, dshRoot,
    request: async () => ({ ok: true, status: 200, json: async () => ({ sha: upstream }) }),
  })
  assert.equal(release.commit, upstream)
})

test('已有安装记录时不再联网改写它', async (t) => {
  const { sourceRoot, dshRoot } = await fixture(t, JSON.stringify({ revision: REVISION }))
  const existing = 'e'.repeat(40)
  await writeFile(path.join(sourceRoot, RELEASE_FILE), JSON.stringify({ commit: existing }))
  const release = await recordInstalledRelease({ sourceRoot, dshRoot, request: async () => { throw new Error('不应联网') } })
  assert.equal(release.commit, existing)
})
