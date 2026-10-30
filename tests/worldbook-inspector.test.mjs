import test from 'node:test'
import assert from 'node:assert/strict'
import { worldbookReadHistory, createWorldbookInspectorHandlers } from '../tavern-plugin/lib/rpc/worldbook-inspector.js'
const call = (id, name, args) => ({ type: 'tool/call', seq: 1, data: { callId: id, name, arguments: JSON.stringify(args), turn: 2, step: 1 } })
const result = (id, isError = false) => ({ type: 'tool/result', data: { message: { toolCallId: id, isError, content: [{ type: 'text', text: 'result' }] }, meta: { totalLines: 2, lines: [{ number: 1, text: 'original' }] } } })
test('history pairs calls/results, retains pending/errors, excludes unrelated tools and malformed arguments', () => {
  const events = [call('a', 'skill', { name: 'wb-old-cluster' }), call('b', 'read', { file_path: '/__tavern_worldbook__/old/entries/a.md', offset: 1 }), call('c', 'read', { file_path: '/etc/file' }), call('d', 'skill', { name: 'normal' }), { type: 'tool/call', data: { arguments: '{' } }, result('b', true), result('a'), call('e', 'skill', { name: 'wb-new' })]
  const rows = worldbookReadHistory(events)
  assert.deepEqual(rows.map(r => [r.id, r.status]), [['e', 'pending'], ['b', 'error'], ['a', 'success']])
  assert.equal(rows[1].result, 'result')
  const metaOnly = result('b'); metaOnly.data.message.content = []
  assert.match(worldbookReadHistory([events[1], metaOnly])[0].result, /1: original/)
})
test('RPC validates loaded game, scopes reads and paginates without losing aggregate counts', async () => {
  const agent = { session: { id: 'one' } }
  const deps = { agentRegistry: { get: id => id === 'one' ? agent : undefined }, chatForSession: async id => id === 'one' ? { sessionId: id } : null,
    worldbookSkillProvider: { inspect: async ({ scope }) => { assert.equal(scope, agent); return { clusters: [] } }, readResource: async (path, { scope }) => { assert.equal(scope, agent); return path === 'allowed' ? ' exact\n' : undefined } },
    sessionDebugEvidence: () => ({ loaded: true, events: Array.from({ length: 45 }, (_, i) => [call(String(i), 'skill', { name: 'wb-a' }), result(String(i))]).flat() }) }
  const rpc = createWorldbookInspectorHandlers(deps)
  const page = await rpc.inspectWorldbookSkills({ sessionId: 'one', offset: 40 })
  assert.equal(page.records.length, 5); assert.equal(page.counts.skills, 45)
  await assert.rejects(rpc.inspectWorldbookSkills({ sessionId: 'other' }), /对局/)
  await assert.rejects(rpc.readWorldbookSkillSource({ sessionId: 'one', path: 'other-game' }), /不属于本局/)
  assert.equal((await rpc.readWorldbookSkillSource({ sessionId: 'one', path: 'allowed' })).content, ' exact\n')
})


test('inline delivery counts actual source text, not old directory-only Skill loads', async () => {
  const root='/profile/worldbook-skills'
  const inline=result('inline');inline.data.message.content=[{type:'text',text:'## 标题\n\noriginal\n'}]
  const events=[call('old','skill',{name:'ke-ju'}),result('old'),call('inline','skill',{name:'ke-ju'}),inline]
  const rpc=createWorldbookInspectorHandlers({agentRegistry:{get:()=>({session:{id:'one'}})},chatForSession:async()=>({sessionId:'one'}),sessionDebugEvidence:()=>({loaded:true,events}),worldbookSkillProvider:{directory:root,inspect:async()=>({clusters:[{name:'ke-ju',entries:[{ref:'ref',inline:true,inlineText:'## 标题\n\noriginal\n',path:root+'/one/SKILL.md',referencePath:root+'/one/references/a.md'}]}]}),readEntry:async ref=>ref==='ref'?'original':undefined}})
  const view=await rpc.inspectWorldbookSkills({sessionId:'one'})
  assert.equal(view.counts.skills,2)
  assert.equal(view.counts.entries,0)
  assert.equal(view.counts.inlineEntries,1)
  assert.equal(view.catalog.clusters[0].entries[0].inlineReadCount,1)
  assert.equal((await rpc.readWorldbookSkillSource({sessionId:'one',ref:'ref'})).content,'original')
  await assert.rejects(rpc.readWorldbookSkillSource({sessionId:'one',ref:'other-game'}),/不属于本局/)
})

test('reference directory reads are navigation rather than original-entry reads', () => {
  const root='/profile/worldbook-skills'
  const records=worldbookReadHistory([call('directory','read',{file_path:root+'/江湖/功法/references/资料目录.md'}),result('directory')],root)
  assert.equal(records.length,1)
  assert.equal(records[0].reference,false)
  assert.equal(records[0].status,'success')
})
