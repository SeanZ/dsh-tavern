import test from 'node:test'
import assert from 'node:assert/strict'
import { describeWorldbookCluster, worldbookEntryTitle, worldbookSkillSlug } from '../tavern-plugin/lib/domain/worldbook-skill-labels.js'

test('exam group uses complete titles, removing mechanical tags but preserving meaningful numbers', () => {
  const label = describeWorldbookCluster([{ title: '158_[mvu_plot]科举·文科鼎甲', content: '# 科举·文科历科鼎甲\n1544甲辰：名单' }, { title: '[mvu_plot]科举·武举武魁', content: '以下是演义预设' }])
  assert.equal(label.title, '科举')
  assert.equal(worldbookSkillSlug(label.title), 'ke-ju')
  assert.equal(label.description, '查询科举。收录文科鼎甲、武举武魁。按资料链接查阅原文。')
  assert.equal(worldbookEntryTitle({title:'1556年科举'}), '1556年科举')
  assert.equal(worldbookEntryTitle({title:'[北境]地图'}), '[北境]地图')
})
test('shared explicit categories and fields create grounded labels without n-grams or body summaries', () => {
  const make = name => ({title:`功法·${name}·底账`,content:'所需穴位：支沟\n要旨：与有无隙可乘\n特效表：正文\n习得登记：类别="暗器"；火候="初窥门径"'})
  const label = describeWorldbookCluster([make('含沙射影'),make('满天花雨')])
  assert.equal(label.title,'暗器功法·底账')
  assert.equal(worldbookSkillSlug(label.title),'an-qi-gong-fa-di-zhang')
  assert.equal(label.description,'查询暗器功法·底账。收录含沙射影、满天花雨。原文提供所需穴位、要旨、特效表、习得登记。')
  assert.doesNotMatch(label.description,/有无隙|修炼门槛/)
})
test('mixed, missing and unstructured titles fall back to source names without guessing a category', () => {
  const label=describeWorldbookCluster([{title:'港口地图',content:'类别：地点\n位置：北方'},{title:'陈掌柜',content:'类别：人物\n性格：严厉'}])
  assert.equal(label.title,'港口地图、陈掌柜')
  assert.deepEqual(label.sharedFields,['类别'])
  assert.equal(worldbookEntryTitle({content:'# 灯塔\n原文',ref:'42'}),'灯塔')
  assert.equal(worldbookEntryTitle({ref:'42'}),'条目 42')
})
