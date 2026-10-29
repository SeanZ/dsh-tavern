import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

test('清单缺失时才走网络，并把拿到的提交号写进安装记录', async (t) => {
  const { sourceRoot, dshRoot } = await fixture(t, null)
  const upstream = 'c'.repeat(40)
  const release = await recordInstalledRelease({
    sourceRoot, dshRoot,
    request: async () => ({ ok: true, status: 200, json: async () => ({ sha: upstream }) }),
  })
  assert.equal(release.commit, upstream)
})
