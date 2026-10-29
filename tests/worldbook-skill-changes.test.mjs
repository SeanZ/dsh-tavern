import test from 'node:test'
import assert from 'node:assert/strict'
import { appendWorldbookSkillChanges } from '../tavern-plugin/lib/domain/worldbook-skill-changes.js'
function payload(events = []) {
  const session = { id: 'game', events, append(type, data) { const event = { seq: this.events.length, type, data }; this.events.push(event); return event } }
  return { agent: { session }, messages: [] }
}
const snapshot = (version, entries) => ({ version, directory: '/skills/' + version, entries })
const entry = (ref, hash) => ({ ref, hash, title: '资料' + ref })
test('one persisted batch notice identifies add/edit/remove and survives restart, retry and version reversal', () => {
  const p = payload(), a = snapshot('a', [entry('1', 'old'), entry('2', 'gone')])
  appendWorldbookSkillChanges(p, a)
  assert.equal(appendWorldbookSkillChanges(p, a), null)
  const restarted = payload(p.messages.map(data => ({ type: 'user/message', data: structuredClone(data) })))
  const b = snapshot('b', [entry('1', 'new'), entry('3', 'added')])
  const notice = appendWorldbookSkillChanges(restarted, b)
  const text = notice.content[0].text
  assert.match(text, /新增（1 条）：资料3/)
  assert.match(text, /改写（1 条）：资料1/)
  assert.match(text, /撤回资料（1 条）：资料2/)
  assert.match(text, /旧绝对路径不再适用/)
  assert.equal(restarted.messages[0], notice)
  assert.equal(appendWorldbookSkillChanges(restarted, b), null)
  const restored = appendWorldbookSkillChanges(restarted, a)
  assert.notEqual(restored.id, p.messages[0].id)
})
test('removing whole book revokes old knowledge in one notice; titles cannot flood the prompt', () => {
  const p = payload()
  appendWorldbookSkillChanges(p, snapshot('large', Array.from({length:40}, (_,i)=>entry('x'.repeat(200)+i,'hash'))))
  const notice = appendWorldbookSkillChanges(p, snapshot('empty', []))
  assert.match(notice.content[0].text, /撤回资料（40 条）/)
  assert.ok(notice.content[0].text.length < 1500)
  assert.equal(appendWorldbookSkillChanges(p,snapshot('empty',[])),null)
})

 test('initial snapshot rides the existing input; native host owns the single durable write', () => {
  const p = payload(), input = { id: 'user-1', role: 'user', content: [{type:'text',text:'继续'}], source:{kind:'user'} }
  p.messages.push(input)
  const a = snapshot('a', [entry('1', 'old')])
  assert.equal(appendWorldbookSkillChanges(p,a),null)
  assert.equal(p.messages.length,1)
  assert.equal(input.content[0].text,'继续')
  assert.equal(p.agent.session.events.length,0)
  p.agent.session.append('user/message',structuredClone(p.messages[0])); p.messages=[]
  assert.equal(appendWorldbookSkillChanges(p,a),null)
  const b=snapshot('b',[entry('1','new')])
  const notice=appendWorldbookSkillChanges(p,b)
  assert.match(notice.content[0].text,/改写（1 条）/)
  assert.equal(p.agent.session.events.length,1)
  assert.equal(p.messages.length,1)
  assert.equal(appendWorldbookSkillChanges(p,b),null)
  p.agent.session.append('user/message',notice)
  const restarted=payload(structuredClone(p.agent.session.events))
  assert.equal(appendWorldbookSkillChanges(restarted,b),null)
})

test('switching an existing session to retrieval accepts immutable host messages without mutating history', () => {
  const original = Object.freeze({ id:'old-save-input', role:'user', content:Object.freeze([{type:'text',text:'继续'}]), source:Object.freeze({kind:'user',trace:'original'}) })
  const p=payload();p.messages.push(original)
  const a=snapshot('first-retrieval',[entry('1','body')])
  assert.doesNotThrow(()=>appendWorldbookSkillChanges(p,a))
  assert.equal(original.source.worldbookSkills,undefined)
  assert.equal(p.messages.length,1)
  assert.notEqual(p.messages[0],original)
  assert.equal(p.messages[0].id,original.id)
  assert.equal(p.messages[0].content,original.content)
  assert.equal(p.messages[0].source.trace,'original')
  assert.equal(p.messages[0].source.worldbookSkills,a)
  p.agent.session.append('user/message',p.messages[0])
  const resumed=payload(structuredClone(p.agent.session.events))
  assert.equal(appendWorldbookSkillChanges(resumed,a),null)
})
