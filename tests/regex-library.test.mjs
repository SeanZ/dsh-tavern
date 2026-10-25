import assert from 'node:assert/strict'
import test from 'node:test'
import { createRegexLibrary } from "../tavern-plugin/lib/domain/regex-library.js"

test('retired library keeps importing raw SillyTavern exports for migration', async () => {
  let value
  const store = { readJson: async () => structuredClone(value), updateJson: async (_, fn) => { value = await fn(structuredClone(value)); return structuredClone(value) } }
  const library = createRegexLibrary({ store })
  const single = { id: 'a', scriptName: '折叠思考', findRegex: '/<think>[\\s\\S]*?<\\/think>/g', replaceString: '', placement: [2], markdownOnly: true, extra: 1 }
  const [item] = await library.importFile(JSON.stringify(single), '文件名')
  assert.equal(item.name, '折叠思考')
  assert.deepEqual(item.script, single)
  const many = await library.importFile(JSON.stringify({ regex_scripts: [{ findRegex: 'x' }, { findRegex: 'y', scriptName: 'Y' }] }), '一组')
  assert.deepEqual(many.map(item => item.name), ['一组', 'Y'])
  assert.equal((await library.list()).length, 3)
  await assert.rejects(library.remove({ id: item.id, expected: { ...item, name: '旧' } }), /已被修改/)
  await library.remove({ id: item.id, expected: item })
  assert.deepEqual((await library.list()).map(entry => entry.name), ['一组', 'Y'])
})

test('legacy items are handed to migration once and then marked, without losing later imports', async () => {
  let value
  const store = { readJson: async () => structuredClone(value), updateJson: async (_, fn) => { value = await fn(structuredClone(value)); return structuredClone(value) } }
  const library = createRegexLibrary({ store })
  await library.importFile(JSON.stringify({ scriptName: '迁移我', findRegex: '/m/g', replaceString: '' }), '旧库')
  const items = await library.legacyForMigration()
  assert.deepEqual(items.map(item => item.name), ['迁移我'])
  await library.markMigrated()
  assert.deepEqual(await library.legacyForMigration(), [])
  await library.importFile(JSON.stringify({ scriptName: '后来导入', findRegex: '/n/g' }), '旧库')
  assert.deepEqual(await library.legacyForMigration(), [])
  assert.deepEqual((await library.list()).map(item => item.name), ['迁移我', '后来导入'])
})
