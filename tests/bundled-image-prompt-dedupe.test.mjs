import test from 'node:test'
import assert from 'node:assert/strict'
import { expandRosterCalls } from '../tavern-plugin/packages/dsh-tavern-image-bundled/lib/index.js'

test('tag 写法里服装的「整体印象」不再写进提示词，自然语言写法照旧', () => {
  const yu = { id: 'y', name: '宋玉轩', match: 'Song Yuxuan', enabled: true, traits: { face: 'long black hair' },
    outfits: [{ id: 'o', name: '常服', upper: 'dark blue jacket', lower: 'dark trousers', full: 'martial attire, practical', default: true }] }
  const tags = expandRosterCalls('${"name":"Song Yuxuan", "outfit":"常服"}$, 1girl', { characters: [yu] }, 'auto')
  assert.match(tags, /dark blue jacket/)
  assert.doesNotMatch(tags, /martial attire/)
  const natural = expandRosterCalls('${"name":"Song Yuxuan", "outfit":"常服"}$', { characters: [yu] }, 'auto', { style: 'natural' })
  assert.match(natural, /martial attire/)
})
