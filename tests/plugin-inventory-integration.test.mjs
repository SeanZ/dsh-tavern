import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse, stringify } from 'yaml'
import { syncUserPlugins, GUARD_FILE } from '../tavern-plugin/lib/domain/user-plugins.js'
import { compareDshVersions } from '../tavern-plugin/lib/domain/host-compatibility.js'

// Uses released host code, not a reimplementation of its manifest contract.
// For a minimal isolated host install, point DSH_INVENTORY_MODULE at
// @deepseek-ai/dsh-plugin-package-inventory-deepseek/lib/index.js.
const anchor = process.env.DSH_INVENTORY_MODULE || process.env.DSH_BOOT_MODULE

// From 0.2.1-rc.0 the host tolerates a plugin whose manifest has no version: it
// advertises the package without one and still prepares the request. Below that an
// incomplete identity failed the whole request, which is the pre-HTTP rejection
// asserted when the installed host predates this behavior.
const HOST_TOLERATES_INCOMPLETE_IDENTITY = '0.2.1-rc.0'

async function readHostVersion() {
  const modulePath = [process.env.DSH_BOOT_MODULE, process.env.DSH_INVENTORY_MODULE].find(Boolean)
  if (!modulePath) return ''
  try {
    const manifest = JSON.parse(await readFile(path.join(path.dirname(path.resolve(modulePath)), '..', 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : ''
  } catch { return '' }
}

test('real DeepSeek request preparation survives a previously registered invalid plugin and its repair', {
  skip: !anchor && 'Requires DSH_BOOT_MODULE or DSH_INVENTORY_MODULE pointing to installed DSH host packages',
}, async t => {
  const require = createRequire(path.resolve(anchor))
  const load = name => import(pathToFileURL(require.resolve(name)).href)
  const [{ Context }, { DeepSeekLlmApiExtensionRegistry }, inventory] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-deepseek-llm-api-extensions'),
    process.env.DSH_INVENTORY_MODULE ? import(pathToFileURL(path.resolve(anchor)).href) : load('@deepseek-ai/dsh-plugin-package-inventory-deepseek'),
  ])
  const dshHome = await mkdtemp(path.join(tmpdir(), 'tavern-inventory-'))
  t.after(() => rm(dshHome, { recursive: true, force: true }))
  const dataRoot = path.join(dshHome, 'profile-data/tavern/data')
  const profile = path.join(dshHome, 'profiles/tavern')
  await mkdir(profile, { recursive: true })
  await writeFile(path.join(profile, 'package.json'), '{}')
  const makePlugin = async (folder, pkg) => {
    const dir = path.join(dataRoot, 'plugins', folder)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ ...pkg, main: './index.mjs' }))
    await writeFile(path.join(dir, 'index.mjs'), 'export function apply() {}\n')
    return dir
  }
  const broken = await makePlugin('legacy-card', { name: 'dsh-card-dafeiyu-galgame' })
  const good = await makePlugin('healthy', { name: 'healthy', version: '2.0.0' })
  const patch = path.join(profile, 'cordis.patch.yml')
  await writeFile(patch, stringify([{ insert: [
    { id: 'tavern-user-plugin-dsh-card-dafeiyu-galgame', name: path.join(broken, GUARD_FILE) },
    { id: 'tavern-user-plugin-healthy', name: path.join(good, GUARD_FILE) },
  ] }]))

  const context = new Context()
  const registry = new DeepSeekLlmApiExtensionRegistry(context)
  // Adapt the generated patch into active Loader metadata. We test the real
  // inventory/extension transaction, not a running Loader or HTTP transport.
  let active = []
  const loader = { ctx: { baseUrl: pathToFileURL(profile + path.sep).href }, entries: () => active }
  const reloadPatch = async () => {
    active = parse(await readFile(patch, 'utf8')).flatMap(op => op.insert || []).map(options => ({
      options, fiber: { state: 2 }, parent: { tree: loader },
    }))
  }
  inventory.apply({ loader, baseUrl: loader.ctx.baseUrl, get: () => undefined, deepseekLlmApiExtensions: registry }, { enabled: true })
  const prepare = () => registry.prepare({ body: {}, signal: new AbortController().signal })
  // 0.2.1 hosts cache package identities per process, so a repaired manifest is only
  // visible through a fresh inventory registration.
  const prepareFresh = () => {
    const freshRegistry = new DeepSeekLlmApiExtensionRegistry(new Context())
    inventory.apply({ loader, baseUrl: loader.ctx.baseUrl, get: () => undefined, deepseekLlmApiExtensions: freshRegistry }, { enabled: true })
    return freshRegistry.prepare({ body: {}, signal: new AbortController().signal })
  }
  const hostVersion = await readHostVersion()
  const hostToleratesIncompleteIdentity = /^\d+\.\d+\.\d+/.test(hostVersion) && compareDshVersions(hostVersion, HOST_TOLERATES_INCOMPLETE_IDENTITY) >= 0
  await reloadPatch()
  if (hostToleratesIncompleteIdentity) {
    // The pre-HTTP failure this test was written to reproduce no longer happens: the
    // request prepares and advertises the plugin whose manifest omits a version.
    // Keeping that plugin out of the patch is still the guard's job, which the
    // user-plugin assertions below cover.
    const packages = (await prepare()).fields.dsh_plugin_packages.packages
    assert.ok(packages.some(pkg => pkg.name === 'healthy' && pkg.version === '2.0.0'), 'healthy plugin is still advertised')
  } else {
    await assert.rejects(prepare, /must declare non-empty name and version/, 'legacy patch reproduces the actual pre-HTTP failure')
  }

  const warnings = []
  const result = await syncUserPlugins({ dataRoot, dshHome, logger: { warn: value => warnings.push(value) } })
  assert.deepEqual(result.problems.map(problem => problem.folder), ['legacy-card'])
  assert.match(warnings.join('\n'), /legacy-card.*version/)
  assert.equal(JSON.parse(await readFile(path.join(broken, 'package.json'), 'utf8')).version, undefined, 'do not invent a version or rewrite third-party manifests')
  await reloadPatch()
  assert.deepEqual((await prepare()).fields.dsh_plugin_packages.packages, [{ name: 'healthy', version: '2.0.0' }])

  await makePlugin('legacy-card', { name: 'dsh-card-dafeiyu-galgame', version: '1.0.0' })
  assert.equal((await syncUserPlugins({ dataRoot, dshHome, logger: { warn() {} } })).problems.length, 0)
  await reloadPatch()
  assert.deepEqual((await (hostToleratesIncompleteIdentity ? prepareFresh() : prepare())).fields.dsh_plugin_packages.packages, [
    { name: 'dsh-card-dafeiyu-galgame', version: '1.0.0' }, { name: 'healthy', version: '2.0.0' },
  ], 'corrected plugins rejoin the next real inventory preparation')
})
