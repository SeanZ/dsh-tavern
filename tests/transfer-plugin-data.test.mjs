import assert from 'node:assert/strict'
import test from 'node:test'

import { createTransferPluginData } from '../tavern-plugin/lib/domain/transfer-plugin-data.js'

const SPEC = 'dsh-tavern.transfer.plugin-data'

const PLUGINS = [
  { folder: 'alpha', name: 'Alpha 插件', enabled: true },
  { folder: 'beta', name: '', enabled: false },
  { folder: 'empty', name: '空插件', enabled: true }
]

/** 内存假 store：read 返回 JSON 往返后的副本，和真实 store 一样每次都是新对象。 */
function fakeStore(initial) {
  const files = new Map(Object.entries(initial).map(([plugin, data]) => [plugin, JSON.stringify(data)]))
  return {
    files,
    async read(plugin) {
      if (!files.has(plugin)) return null
      return JSON.parse(files.get(plugin))
    },
    async save(plugin, data) {
      if (data === null) { files.delete(plugin); return }
      files.set(plugin, JSON.stringify(data))
    }
  }
}

function fixture(data) {
  const store = fakeStore(data)
  const transfer = createTransferPluginData({ pluginDataStore: store, listPlugins: async () => PLUGINS })
  return { store, transfer }
}

function parseContent(item) {
  return JSON.parse(item.content.toString('utf8'))
}

test('list 跳过没有数据的插件，标题与字节数按插件数据算', async () => {
  const alphaData = { theme: 'dark', settings: { size: 12 } }
  const betaData = { greeting: '你好' }
  const { transfer } = fixture({ alpha: alphaData, beta: betaData })

  const rows = await transfer.list()

  assert.deepEqual(rows.map(row => row.key), ['alpha', 'beta'])
  assert.deepEqual(rows[0], {
    key: 'alpha',
    title: 'Alpha 插件',
    meta: '插件数据',
    bytes: Buffer.byteLength(JSON.stringify(alphaData))
  })
  assert.equal(rows[1].title, 'beta', '没有 name 时用文件夹名')
  assert.equal(rows[1].bytes, Buffer.byteLength(JSON.stringify(betaData)))
})

test('collect 递归剥离凭据：嵌套对象、数组里的对象都换占位串并记点路径', async () => {
  const original = {
    apiKey: 'sk-live-1',
    keep: 'ok',
    nested: { token: 'tok-1', model: 'gpt', deeper: { password: 'p-1' } },
    list: [
      { name: 'A', api_key: 'k-2' },
      { name: 'B', deep: { authorization: 'Bearer zz' } },
      { plain: 1 }
    ],
    count: 3
  }
  const { transfer } = fixture({ alpha: original })

  const [item] = await transfer.collect(['alpha'])
  const parsed = parseContent(item)

  assert.equal(item.key, 'alpha')
  assert.equal(item.title, 'Alpha 插件')
  assert.equal(item.fileName, 'alpha.json')
  assert.equal(parsed.spec, SPEC)
  assert.equal(parsed.version, 1)
  assert.equal(parsed.plugin, 'alpha')
  assert.equal(parsed.redacted, true)
  assert.deepEqual(parsed.redactedKeys, [
    'apiKey',
    'nested.token',
    'nested.deeper.password',
    'list[0].api_key',
    'list[1].deep.authorization'
  ])
  assert.deepEqual(parsed.data, {
    apiKey: '[已移除]',
    keep: 'ok',
    nested: { token: '[已移除]', model: 'gpt', deeper: { password: '[已移除]' } },
    list: [
      { name: 'A', api_key: '[已移除]' },
      { name: 'B', deep: { authorization: '[已移除]' } },
      { plain: 1 }
    ],
    count: 3
  })
  assert.deepEqual(original, {
    apiKey: 'sk-live-1',
    keep: 'ok',
    nested: { token: 'tok-1', model: 'gpt', deeper: { password: 'p-1' } },
    list: [
      { name: 'A', api_key: 'k-2' },
      { name: 'B', deep: { authorization: 'Bearer zz' } },
      { plain: 1 }
    ],
    count: 3
  }, '不能改原对象')
})

test('collect 没有凭据时 redacted 为 false，redactedKeys 为空', async () => {
  const { transfer } = fixture({ beta: { theme: 'light' } })
  const [item] = await transfer.collect(['beta'])
  const parsed = parseContent(item)
  assert.equal(parsed.redacted, false)
  assert.deepEqual(parsed.redactedKeys, [])
  assert.deepEqual(parsed.data, { theme: 'light' })
})

test('collect 最多记 20 条 redactedKeys，但把所有命中的值都换掉', async () => {
  const data = {}
  for (let index = 0; index < 25; index += 1) data['token' + index] = 'v' + index
  const { transfer } = fixture({ alpha: data })
  const [item] = await transfer.collect(['alpha'])
  const parsed = parseContent(item)
  assert.equal(parsed.redactedKeys.length, 20)
  assert.equal(parsed.redactedKeys[0], 'token0')
  assert.equal(parsed.redactedKeys[19], 'token19')
  assert.equal(Object.values(parsed.data).filter(value => value === '[已移除]').length, 25)
})

test('collect 对未知/没有数据的插件报中文错', async () => {
  const { transfer } = fixture({ alpha: { keep: 1 } })
  await assert.rejects(() => transfer.collect(['nope']), /插件数据不存在：nope/)
  await assert.rejects(() => transfer.collect(['empty']), /插件数据不存在：empty/)
})

test('fileName 把非法字符换成下划线', async () => {
  const { transfer } = fixture({ 'a/b': { keep: 1 } })
  const [item] = await transfer.collect(['a/b'])
  assert.equal(item.fileName, 'a_b.json')
  assert.equal(parseContent(item).plugin, 'a/b')
})

test('importOne 写回数据并返回 redacted 标记，plugin 取 key', async () => {
  const { store, transfer } = fixture({})
  const content = Buffer.from(JSON.stringify({
    spec: SPEC,
    version: 1,
    plugin: 'ignored',
    data: { apiKey: '[已移除]', keep: 'ok' },
    redacted: true
  }))

  const result = await transfer.importOne({ key: 'alpha', title: 'Alpha 插件', content })

  assert.deepEqual(result, { plugin: 'alpha', redacted: true })
  assert.deepEqual(JSON.parse(store.files.get('alpha')), { apiKey: '[已移除]', keep: 'ok' })
})

test('importOne 没有 key 时用 JSON 里的 plugin，redacted 缺省为 false', async () => {
  const { store, transfer } = fixture({})
  const content = JSON.stringify({ spec: SPEC, version: 1, plugin: 'beta', data: { keep: 1 } })
  const result = await transfer.importOne({ content })
  assert.deepEqual(result, { plugin: 'beta', redacted: false })
  assert.deepEqual(JSON.parse(store.files.get('beta')), { keep: 1 })
})

test('collect 的导出能原样 importOne 回去', async () => {
  const data = { token: 'secret', keep: 'ok' }
  const { transfer } = fixture({ alpha: data })
  const [item] = await transfer.collect(['alpha'])
  const target = fixture({})
  const result = await target.transfer.importOne(item)
  assert.deepEqual(result, { plugin: 'alpha', redacted: true })
  assert.deepEqual(JSON.parse(target.store.files.get('alpha')), { token: '[已移除]', keep: 'ok' })
})

test('importOne 对坏 JSON 与 spec 不符报中文错', async () => {
  const { transfer } = fixture({})
  await assert.rejects(() => transfer.importOne({ key: 'alpha', content: '{ not json' }), /插件数据不是有效的 JSON：alpha/)
  await assert.rejects(() => transfer.importOne({ key: 'alpha', content: JSON.stringify({ spec: 'other', data: {} }) }), /插件数据格式不符：alpha/)
  await assert.rejects(() => transfer.importOne({ key: 'alpha', content: JSON.stringify({ spec: SPEC }) }), /插件数据格式不符：alpha/)
  await assert.rejects(() => transfer.importOne({ key: 'alpha' }), /插件数据内容为空/)
})
