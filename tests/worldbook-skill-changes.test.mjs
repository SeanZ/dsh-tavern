import test from 'node:test'
import assert from 'node:assert/strict'
import { appendWorldbookSkillChanges } from '../tavern-plugin/lib/domain/worldbook-skill-changes.js'
function payload(events = []) {
  const session = { id: 'game', events, append(type, data) { const event = { seq: this.events.length, type, data }; this.events.push(event); return event } }
  return { agent: { session }, messages: [] }
}
const snapshot = (version, entries) => ({ version, directory: '/skills/' + version, entries })
const entry = (ref, hash) => ({ ref, hash, title: '资料' + ref })
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
