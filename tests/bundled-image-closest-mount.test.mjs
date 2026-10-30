import test from 'node:test'
import assert from 'node:assert/strict'
import { closestMount } from '../tavern-plugin/packages/dsh-tavern-image-bundled/lib/index.js'

const body = '她推开门，雪落在肩头。屋里的炉火还亮着，她把湿透的斗篷挂在门边。他抬头看她，没说话。'

test('规划抄错几个字的挂载句：找回正文里最像的那一句', () => {
  assert.equal(closestMount('她把湿掉的斗篷挂在门边。', body), '屋里的炉火还亮着，她把湿透的斗篷挂在门边。')
  assert.equal(closestMount('他抬起头看她，没说话。', body), '他抬头看她，没说话。')
})

test('完全对不上、或太短：不硬挂', () => {
  assert.equal(closestMount('窗外的海浪拍着礁石。', body), '')
  assert.equal(closestMount('她', body), '')
})
