import test from 'node:test'
import assert from 'node:assert/strict'
import { STORY_SUMMARY_NOTE, storyVolumeMerge, storyVolumePlan } from '../tavern-plugin/lib/domain/story-compaction.js'

const preamble = 'This is an automatically generated checkpoint ...\n\n<compacted-summary>'
const checkpoint = texts => ({ id: 'cp', role: 'user', source: { kind: 'plugin:compact', compactionId: 'c1' }, content: [preamble, ...texts, '</compacted-summary>'].map(text => ({ type: 'text', text })) })
const request = history => ({ purpose: 'compaction', messages: [...history, { role: 'user', content: [{ type: 'text', text: '总结指令' }] }] })
const player = text => ({ role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text }] })

test('旧卷超出预算时只合并最老的几卷，较新的卷原样保留，新一卷照常写', () => {
  const volume = (from, to, size) => `【第 ${from}–${to} 轮剧情摘要】\n` + '事'.repeat(size)
  const old = checkpoint([volume(1, 50, 300), volume(51, 110, 300), volume(111, 170, 300)])
  const plan = storyVolumePlan(request([old]), { through: 230, budget: 700, estimate: text => text.length })
  assert.deepEqual(plan.merge.volumes.map(item => item.through), [50, 110])
  assert.equal(plan.merge.through, 110)
  assert.deepEqual(plan.prefix, [STORY_SUMMARY_NOTE, volume(111, 170, 300)])
  assert.match(plan.instruction, /「【第 171–230 轮剧情摘要】」/)
  const merge = storyVolumeMerge(plan.merge)
  assert.equal(merge.header, '【前情总览（截至第 110 轮）】')
  assert.match(merge.prompt, /约为原文的一半/)
  assert.ok(merge.prompt.includes(volume(1, 50, 300)) && merge.prompt.includes(volume(51, 110, 300)) && !merge.prompt.includes(volume(111, 170, 300)))
})
