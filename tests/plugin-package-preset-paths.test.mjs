import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 标准插件包（dsh plugin add）装进 profile 后，用宿主自己的 app-boot 读取并组合包内补丁，
// 再用预设 Loader 导入时同一个 Node 内部解析器、以 profile 目录为基准解析前后台预设里的插件行。
// 宿主只锚定顶层与 group 的 insert 行；预设 config.plugins 行必须靠包名子路径落到包内。
// 运行时取 DSH_BOOT_MODULE，否则取本仓库链接的宿主；都没有时跳过。

const root = fileURLToPath(new URL('../', import.meta.url))

function resolveBootModule() {
  if (process.env.DSH_BOOT_MODULE) return process.env.DSH_BOOT_MODULE
  try {
    const pluginRequire = createRequire(new URL('../tavern-plugin/package.json', import.meta.url))
    return createRequire(pluginRequire.resolve('@deepseek-ai/dsh-tools')).resolve('@deepseek-ai/dsh-app-boot')
  } catch {
    return null
  }
}

const bootModule = resolveBootModule()

// 预设行（含 group 子行）按声明顺序展开，记下所属预设与行 id。
function presetRows(rows) {
  const found = []
  const walk = (presetId, list) => {
    for (const row of list) {
      found.push({ presetId, id: row.id, name: row.name })
      if (Array.isArray(row.config)) walk(presetId, row.config)
    }
  }
  for (const row of rows) if (row.name === '@deepseek-ai/dsh-agent-preset') walk(row.config.id, row.config.plugins)
  return found
}

const inside = async (file, directory) => (await realpath(file)).startsWith((await realpath(directory)) + path.sep)

test(
  '标准插件包的前后台预设插件行由宿主加载器解析到包内文件',
  { skip: !bootModule && '需要 DSH_BOOT_MODULE 指向宿主 dsh-app-boot', timeout: 60000 },
  async (t) => {
    const boot = await import(pathToFileURL(bootModule).href)
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    const patchText = await readFile(path.join(root, 'plugin.patch.yml'), 'utf8')
    const relativeEntries = [...patchText.matchAll(/^\s*name: \.\/(\S+)\s*$/gm)].map((match) => match[1])
    const ownEntries = [...patchText.matchAll(new RegExp(`^\\s*name: ${manifest.name}/(\\S+)\\s*$`, 'gm'))].map(
      (match) => match[1],
    )
    assert.ok(ownEntries.length > 0, '预设行应使用本包包名子路径')

    const temp = await mkdtemp(path.join(tmpdir(), 'tavern-plugin-package-'))
    t.after(() => rm(temp, { recursive: true, force: true }))
    // 空的安装锚点：本包只能从 profile 自己的 node_modules 找到，与 dsh plugin add 的布局一致。
    const installAnchor = path.join(temp, 'install', 'package.json')
    await mkdir(path.dirname(installAnchor), { recursive: true })
    await writeFile(installAnchor, JSON.stringify({ name: 'dsh-test-install', version: '0.0.0' }))

    // tavern 档的 profile 清单名与本包同名（文档推荐的安装方式），web 档为普通名字。
    for (const profileName of ['tavern', 'web']) {
      const profileDir = path.join(temp, 'profiles', profileName)
      const packageDir = path.join(profileDir, 'node_modules', manifest.name)
      for (const file of new Set(['package.json', 'plugin.patch.yml', ...relativeEntries, ...ownEntries])) {
        await mkdir(path.dirname(path.join(packageDir, file)), { recursive: true })
        await copyFile(path.join(root, file), path.join(packageDir, file))
      }
      await writeFile(
        path.join(profileDir, 'package.json'),
        JSON.stringify({
          name: `dsh-profile-${profileName}`,
          private: true,
          dependencies: { [manifest.name]: manifest.version },
          dsh: { profile: { bundles: [manifest.name] } },
        }),
      )

      const profile = boot.loadProfileDirectory('dsh', profileDir, installAnchor, { userLayer: false })
      assert.deepEqual(profile.skippedBundles, [], profileName)
      assert.equal(profile.layers.length, 1)
      assert.equal(await realpath(profile.layers[0].packageDir), await realpath(packageDir))
      const rows = boot.composeEntries([profile.layers[0].patches])

      // 顶层相对入口由宿主锚定为包内 file URL。
      const anchored = rows.filter((row) => typeof row.name === 'string' && row.name.startsWith('file:'))
      assert.equal(
        anchored.length,
        relativeEntries.length,
        `${profileName}：顶层相对入口应全部被锚定，预设内不应再有相对入口`,
      )
      for (const row of anchored)
        assert.ok(await inside(fileURLToPath(row.name), packageDir), `${row.id} 未锚定到包内：${row.name}`)

      // 预设行以声明所在 profile 目录为解析基准（宿主 Include 的 baseUrl）。
      const baseUrl = pathToFileURL(profileDir + path.sep).href
      const own = presetRows(rows).filter(
        (row) => !row.name.startsWith('@deepseek-ai/') && !row.name.startsWith('cordis:'),
      )
      assert.deepEqual(
        own.map((row) => `${row.presetId}/${row.id}`),
        ['tavern/user-tools', 'tavern/tavern-compaction', 'tavern-background/tavern-compaction'],
      )
      for (const row of own) {
        const resolved = boot.resolvePluginResource(row.name, baseUrl)
        assert.ok(await inside(resolved, packageDir), `${row.presetId}/${row.id} 解析到包外：${resolved}`)
      }
      // 旧写法的相对路径按 profile 目录解析，正是预设报 never started 的原因。
      assert.throws(
        () => boot.resolvePluginResource('./tavern-plugin/lib/agent-compaction.js', baseUrl),
        (error) => error.code === 'ERR_MODULE_NOT_FOUND',
      )
    }
  },
)
