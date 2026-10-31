import test from 'node:test'
import assert from 'node:assert/strict'
import { closestMount, resolveMountFallback } from '../tavern-plugin/packages/dsh-tavern-image-bundled/lib/index.js'

const body = '她推开门，雪落在肩头。屋里的炉火还亮着，她把湿透的斗篷挂在门边。他抬头看她，没说话。'

test('挂载回退默认关闭，开启后只接受唯一的单字错漏', () => {
  const source = '屋里的炉火还亮着，她把湿透的斗篷挂在门边。'
  const typo = '屋里的炉火还亮着，她把湿透的斗蓬挂在门边。'
  assert.equal(resolveMountFallback({}, typo, source), '')
  assert.equal(resolveMountFallback({ closestMountTolerance: true }, typo, source), source)
  assert.equal(closestMount('他抬头看她，轻轻的笑了一下，随后没有说话。', '他抬头看她，轻轻地笑了一下，随后没有说话。'), '他抬头看她，轻轻地笑了一下，随后没有说话。')
})

test('完全对不上、或太短：不硬挂', () => {
  assert.equal(closestMount('窗外的海浪拍着礁石。', body), '')
  assert.equal(closestMount('她', body), '')
  assert.equal(closestMount('他走向门口。', '他走向床边。'), '', '相似度不足时不把图错挂到另一处')
  assert.equal(closestMount('她脱下湿透的外套，站在门口等他回来。', '她穿上湿透的外套，站在门口等他回来。'), '', '动作相反时拒绝回退')
  assert.equal(closestMount('她把红色窗帘拉开，阳光照进屋里。', '她把蓝色窗帘拉开，阳光照进屋里。'), '', '颜色不同不能当成错字')
  assert.equal(closestMount('她没有狐耳，转身走进屋里。', '她有狐耳，转身走进屋里。'), '', '否定变化不能当成错字')
  assert.equal(closestMount('她推开门，走进房间。', '她推开门，走进房间。她推开门，走进房间。'), '', '多个同分挂载位置视为歧义')
})
