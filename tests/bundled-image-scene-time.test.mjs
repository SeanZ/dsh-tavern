import test from 'node:test'
import assert from 'node:assert/strict'
import { addSceneTime, crowdSize, sceneHeadcount } from '../tavern-plugin/packages/dsh-tavern-image-bundled/lib/index.js'

test('画面写了夜里：补一句窗外漆黑，插在镜头句后面', () => {
  const out = addSceneTime('近景，正面平视。夜里的厨房，她在切菜。', '')
  assert.equal(out, '近景，正面平视。时间是夜里，画面里看得到的窗外、门外和天空都是漆黑的夜色，光线昏暗，只有近处被灯火照亮。夜里的厨房，她在切菜。')
})

test('画面没写时间：从正文最后一个状态栏补；写了白天或已经写了漆黑的不动', () => {
  const body = '[时间|腊月廿三|傍晚|酉时]\n她推门进来。'
  assert.match(addSceneTime('全身，客厅里她脱下外套。', body), /时间是傍晚/)
  assert.equal(addSceneTime('全身，午后的阳光照进客厅。', body), '全身，午后的阳光照进客厅。')
  assert.equal(addSceneTime('夜里，窗外漆黑，她点灯。', ''), '夜里，窗外漆黑，她点灯。')
  assert.equal(addSceneTime('1girl, night, kitchen', ''), '1girl, night, kitchen', '英文 tag 画面不动')
  assert.equal(addSceneTime('她的长发如夜幕般垂落，午后阳光明亮。', body), '她的长发如夜幕般垂落，午后阳光明亮。')
  assert.equal(addSceneTime('她并非在夜里，午后阳光照亮客厅。', body), '她并非在夜里，午后阳光照亮客厅。')
  assert.equal(addSceneTime('午后阳光洒进屋里，窗外夜色渐深。', body), '午后阳光洒进屋里，窗外夜色渐深。', '昼夜线索冲突时不擅自补时间')
})

test('开头的人物宏和镜头句保持在前面，时间句插在它们后面', () => {
  const scene = '${"name":"Xu Jinghao"}$\n半身，平视。夜里她站在路灯下。'
  assert.ok(addSceneTime(scene, '').startsWith('${"name":"Xu Jinghao"}$\n半身，平视。时间是夜里'))
})

test('三个人以上：竖图改横图；两个人不动', () => {
  const three = '${"name":"A"}$ 她站着。${"name":"B"}$ 他坐着。${"name":"C"}$ 她笑着。'
  assert.equal(sceneHeadcount(three), 3)
  assert.equal(crowdSize('竖图', three), '竖图')
  assert.equal(crowdSize('', three), '横图')
  assert.equal(crowdSize('横图', three), '横图')
  assert.equal(crowdSize('竖图', '${"name":"A"}$ ${"name":"B"}$ 画面里是两个人。'), '竖图')
  assert.equal(crowdSize('832x1216', '画面里是三个人。'), '832x1216')
  assert.equal(crowdSize('portrait', three), 'portrait')
  const twoCharactersAndOutfit = '${"name":"A"}$ 她站着。${"name":"B"}$ 他坐着。${"name":"夏日制服","upperBody":"visible"}$'
  assert.equal(sceneHeadcount(twoCharactersAndOutfit), 2)
  assert.equal(crowdSize('', twoCharactersAndOutfit), '')
})
