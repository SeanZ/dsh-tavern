import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPlannerSystem } from '../tavern-plugin/packages/dsh-tavern-image-bundled/lib/planner.js'

test('记录当前穿着：临时状态（湿、脏、扣子解开）不记进去，颜色照正文，中文人物用中文', () => {
  const system = buildPlannerSystem({ rules: '', roster: '', count: 2, characterUpdates: true })
  assert.match(system, /衣服临时的状态（湿、脏、洇出水渍、扣子解开、袖子挽起）不记进当前穿着/)
  assert.match(system, /颜色照正文写的来/)
  assert.match(system, /外貌是中文写的就用中文/)
  assert.doesNotMatch(system, /"outfit":"英文完整描述/)
})
