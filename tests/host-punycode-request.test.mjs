import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { routePunycodeRequest } from '../tavern-plugin/lib/domain/host-punycode-request.js'

// DSH 0.2.1-rc.2 把 Profile 内包的 require("punycode/") 截成内置模块名 punycode，
// resolve.paths 返回 null，整个酒馆导入失败；插件形态（dsh plugin add）下后端全部 404。
test('punycode/ 改写成 npm 包目录，其它请求原样交给宿主', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-punycode-'))
  const modules = join(root, 'node_modules')
  await mkdir(join(modules, 'punycode'), { recursive: true })
  await writeFile(join(modules, 'punycode', 'package.json'), '{"name":"punycode"}')
  const seen = []
  const moduleApi = { _resolveFilename(request) { seen.push(request); return request } }
  routePunycodeRequest(moduleApi)
  routePunycodeRequest(moduleApi)
  const parent = { paths: [join(root, 'missing'), modules] }
  moduleApi._resolveFilename('punycode/', parent)
  moduleApi._resolveFilename('punycode', parent)
  moduleApi._resolveFilename('jsdom', parent)
  assert.deepEqual(seen, [join(modules, 'punycode') + '/', 'punycode', 'jsdom'])
})

test('找不到 npm punycode 时不改写', () => {
  const seen = []
  const moduleApi = { _resolveFilename(request) { seen.push(request); return request } }
  routePunycodeRequest(moduleApi)
  moduleApi._resolveFilename('punycode/', { paths: [] })
  moduleApi._resolveFilename('punycode/', null)
  assert.deepEqual(seen, ['punycode/', 'punycode/'])
})

test('酒馆入口第一条导入就是 punycode 改写', async () => {
  const source = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
  const first = source.split(/\r?\n/).find(line => line.startsWith('import '))
  assert.equal(first, "import './domain/host-punycode-request.js'")
})
