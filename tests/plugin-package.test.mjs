import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from "node:url"
import { parse } from 'acorn'
import vm from 'node:vm'
import { sourceFunction } from './fixtures/source-function.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = name => readFileSync(path.join(root, name), 'utf8')

test('standard package ships runtime resources without local links, host copies or install scripts', () => {
  const manifest = JSON.parse(read('package.json'))
  assert.deepEqual(manifest.dsh.bundle, { patch: './plugin.patch.yml' })
  assert.equal(manifest.bin, undefined, 'standard installation must not replace the legacy launcher')
  for (const [name, spec] of Object.entries(manifest.dependencies)) {
    assert.ok(!/^(link|file):/.test(spec), `${name} depends on checkout paths`)
    assert.ok(!name.startsWith('@deepseek-ai/'), `${name} would install a second host`)
    assert.notEqual(name, 'node-pty')
  }
  for (const name of ['prepare', 'preinstall', 'install', 'postinstall']) assert.equal(manifest.scripts[name], undefined)
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }))
  const files = new Set(packed.files.map(file => file.path))
  // 沿服务端入口递归验证相对导入，防止二级模块引用被包裁剪遗漏。
  const pending = ['tavern-plugin/lib/index.js',
    'tavern-plugin/packages/dsh-asset-library/lib/index.js',
    'tavern-plugin/packages/dsh-tavern-stage/lib/index.js',
    'tavern-plugin/packages/dsh-tavern-tts/lib/index.js']
  const visited = new Set()
  while (pending.length) {
    const entryPath = pending.pop()
    if (visited.has(entryPath)) continue
    visited.add(entryPath)
    const nodes = [parse(read(entryPath), { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true })]
    while (nodes.length) {
      const node = nodes.pop()
      const specifier = ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type)
        ? node.source?.value
        : node.type === 'CallExpression' && node.callee?.name === 'require' ? node.arguments[0]?.value : undefined
      if (typeof specifier === 'string' && specifier.startsWith('.')) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), specifier))
        const resolved = [target, target + '.js', target + '.cjs', target + '/index.js'].find(name => files.has(name))
        assert.ok(resolved, `${entryPath} imports missing runtime module: ${target}`)
        if (/\.(?:mjs|cjs|js)$/.test(resolved)) pending.push(resolved)
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) nodes.push(...value.filter(item => item && typeof item.type === 'string'))
        else if (value && typeof value.type === 'string') nodes.push(value)
      }
    }
  }
  for (const name of [
    'plugin.patch.yml', 'bin/plugin-package-guard.mjs', 'bin/update-diagnostics.mjs',
    'config/dsh-compatibility.json', 'config/plugin-web.LICENSE',
    'tavern-plugin/package.json', 'tavern-plugin/lib/index.js', 'tavern-plugin/lib/client.js',
    'tavern-plugin/lib/user-tools-bridge.js',
    'tavern-plugin/packages/dsh-asset-library/lib/index.js',
    'tavern-plugin/packages/dsh-tavern-stage/lib/index.js',
    'tavern-plugin/packages/dsh-tavern-stage/lib/client.js',
    'tavern-plugin/shared/sprite-emotions.cjs',
    'tavern-plugin/packages/dsh-tavern-card-memory/index.js',
    'tavern-plugin/packages/dsh-tavern-card-memory/package.json',
    'tavern-plugin/packages/dsh-tavern-remote/lib/typert.host.js',
    'tavern-plugin/packages/dsh-better-sidebar/lib/client-mermaid.js',
    'tavern-plugin/packages/dsh-dream-skin/lib/index.js',
    'tavern-plugin/packages/dsh-dream-skin/lib/client.js',
    'tavern-plugin/packages/dsh-dream-skin/LICENSE',
    'tavern-plugin/lib/vendor/st-prompt-template/upstream/settings.html',
    'tavern-plugin/lib/vendor/st-prompt-template/server-artifact/engine.js',
    'tavern-plugin/lib/vendor/runtime-assets/jquery/jquery.min.js',
    'tavern-plugin/lib/vendor/runtime-assets/lodash/lodash.min.js',
  ]) assert.ok(files.has(name), `missing runtime resource: ${name}`)
  assert.ok(files.has('tavern-plugin/src/client/bubble-line.cjs'), '共享气泡解析器是服务端运行依赖')
  assert.deepEqual([...files].filter(name => name.startsWith('tavern-plugin/src/')).sort(), [...visited].filter(name => name.startsWith('tavern-plugin/src/')).sort())
  const catalog = JSON.parse(read('tavern-plugin/packages/dsh-dream-skin/lib/font-catalog.json'))
  for (const family of catalog.families) {
    assert.ok(files.has(`tavern-plugin/packages/dsh-dream-skin/fonts/${family.id}/index.json`))
    assert.ok(files.has(`tavern-plugin/packages/dsh-dream-skin/fonts/${family.id}/LICENSE.txt`))
    for (const face of family.files) assert.ok(!files.has(`tavern-plugin/packages/dsh-dream-skin/fonts/${family.id}/${face.file}`), '可按需缓存字体不重复随包交付')
  }
  assert.ok([...files].some(name => /fontawesome.*\.(woff2|ttf)$/i.test(name)), '图标字体保持随包提供')
  assert.ok([...files].some(name => name.startsWith('presets/tavern/skills/')))
  assert.ok(![...files].some(name => /(^|\/)(node_modules|tests|docs)\//.test(name)))
  assert.deepEqual([...files].filter(name => name.includes('/upstream/')), ['tavern-plugin/lib/vendor/st-prompt-template/upstream/settings.html'])
  // 0.2.0-rc.2 适配：preset 不再是 presets/ 下的目录（agent.cordis.yml + preset.yml），
  // 而是 bundle patch 里的 @deepseek-ai/dsh-agent-preset 声明行。声明行里 `name` 的解析基准
  // 是声明文件所在目录（profile 目录），相对路径会解析失败，因此这里只允许裸包说明符，
  // 并逐条验证它确实随包发布。
  const pluginPatch = read('tavern-plugin/cordis.patch.yml')
  const presetRows = pluginPatch.split('\n').filter(line => /^\s*name: '@deepseek-ai\/dsh-agent-preset'\s*$/.test(line))
  assert.equal(presetRows.length, 2, 'tavern 与 tavern-background 两个 preset 声明行必须存在')
  for (const [, specifier] of pluginPatch.matchAll(/^\s*name: (\.\.?\/\S+)\s*$/gm)) {
    assert.fail(`preset 声明行不得使用相对路径（0.2.0 的解析基准是 profile 目录）：${specifier}`)
  }
  for (const [, specifier] of pluginPatch.matchAll(/^\s*name: (dsh-tavern-plugin\/\S+)\s*$/gm)) {
    const exported = JSON.parse(read('tavern-plugin/package.json')).exports[`.${specifier.slice('dsh-tavern-plugin'.length)}`]
    assert.ok(exported, `${specifier} 未在 tavern-plugin/package.json 的 exports 中声明`)
    assert.ok(files.has(path.posix.join('tavern-plugin', exported.replace(/^\.\//, ''))), `${specifier} 指向的文件不在发布包内`)
  }
  // 标准插件包的预设行不经宿主锚定、按 profile 目录解析：只能用本包包名的子路径，且目标随包发布。
  const bundlePatch = read('plugin.patch.yml')
  for (const name of ['dsh-asset-library', 'dsh-tavern-stage', 'dsh-tavern-tts']) {
    assert.ok(bundlePatch.includes('name: ./tavern-plugin/packages/' + name + '/lib/index.js'))
    const embedded = JSON.parse(read('tavern-plugin/packages/' + name + '/package.json'))
    for (const [dependency, version] of Object.entries(embedded.dependencies || {})) {
      assert.equal(manifest.dependencies[dependency], version, '内嵌组件依赖必须在标准包声明：' + dependency)
    }
  }
  const presets = bundlePatch.slice(bundlePatch.indexOf('- id: preset-tavern\n'), bundlePatch.indexOf('- id: dsh-tavern-remote\n'))
  assert.deepEqual([...presets.matchAll(/^\s*name: (\.\.?\/\S+)\s*$/gm)].map(match => match[1]), [])
  const ownRows = [...presets.matchAll(new RegExp(`^\\s*name: ${manifest.name}/(\\S+)\\s*$`, 'gm'))].map(match => match[1])
  assert.deepEqual(ownRows, ['tavern-plugin/lib/host/tools.js', 'tavern-plugin/lib/user-tools-bridge.js', 'tavern-plugin/lib/agent-compaction.js', 'tavern-plugin/lib/host/tools.js', 'tavern-plugin/lib/agent-compaction.js'])
  for (const file of ownRows) assert.ok(files.has(file), `预设行指向的文件不在发布包内：${file}`)
  parse(read('tavern-plugin/lib/client.js'), { ecmaVersion: 'latest', sourceType: 'script' })
})

test('standard bundle and sidebar distribution match their maintained sources', () => {
  execFileSync(process.execPath, ['bin/build-plugin-package.mjs', '--check'], { cwd: root })
  const patchTitle = vm.runInNewContext(sourceFunction(read('bin/vendor-plugin-package.mjs'), 'patchSidebarTitle') + '; patchSidebarTitle')
  for (const name of ['index.js', 'client.js', 'client-registry.js', 'client-terminal.js', 'client-editor.js', 'client-mermaid.js', 'client-locale.js']) {
    const source = read(`node_modules/dsh-better-sidebar/lib/${name}`)
    const expected = name === 'client.js' || name === 'client-registry.js' ? patchTitle(source) : source
    assert.equal(read(`tavern-plugin/packages/dsh-better-sidebar/lib/${name}`), expected)
  }
  assert.match(read('tavern-plugin/packages/dsh-better-sidebar/lib/index.js'), /function threadOwnLogEvents\(/)
})


test('素材库通过目标宿主兼容检查，不依赖用户豁免', async () => {
  assert.ok(process.env.DSH_BOOT_MODULE, '需要实际宿主加载器')
  const { evaluatePluginCompatibility } = await import(pathToFileURL(process.env.DSH_BOOT_MODULE))
  const manifest = JSON.parse(read('tavern-plugin/packages/dsh-asset-library/package.json'))
  assert.equal(evaluatePluginCompatibility(manifest, {}, '0.2.2-alpha.2'), undefined)
})
