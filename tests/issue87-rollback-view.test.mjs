import { createSessionViewReader } from '../tavern-plugin/lib/domain/session-view-reader.js'
import { projectChatSessionState, createSessionStateView } from '../tavern-plugin/lib/domain/chat-session-state.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'

test('cached rollback controls follow the stored Session surface without resuming an Agent', async () => {
  const source=await readFile(new URL('../tavern-plugin/lib/index.js',import.meta.url),'utf8')
  const evidence=source.slice(source.indexOf('  function sessionDebugEvidence('),source.indexOf('  const readBackgroundSuppression'))
  const session={id:'s',events:[
    {seq:0,type:'user/message',data:{role:'user',source:{kind:'user'}}},
    {seq:1,type:'assistant/message',data:{turn:2,message:{source:{kind:'model',provider:'test',model:'test'}}}}
  ],surface:{nodes:[0,1]}}
  const chat={id:'c',sessionId:'s',mode:'story',cardPath:'card',_storageRevision:1,messages:[{role:'user'},{role:'assistant',turn:2}]}
  let loaded=true
  const context={str:String,sessionEvents,
    ctx:{get:()=>({get:()=>loaded?session:undefined})},
    agentRegistry:{get:()=>undefined,resume:()=>{throw Error('view must not resume')}},
    requestPerformance:{stage:(_name,fn)=>fn(),state(){}}}
  const evidenceOf=vm.runInNewContext(`(()=>{${evidence}\nreturn sessionDebugEvidence})()`,context)
  const fields=createSessionStateView({activity:()=>({busy:false}),evidence:id=>evidenceOf(id,true)})
  const reader=createSessionViewReader({readState:async()=>projectChatSessionState(chat),readChat:async()=>chat,
    project:{full:async value=>fields.volatile(value,{busy:false}),cached:async(value,previous,activity)=>({...previous,...fields.volatile(value,activity)})},
    readChanges:async()=>null,activity:()=>({busy:false}),trace:context.requestPerformance,foregroundRunning:()=>false,synchronize:()=>{}})
  const run=reader.read
  assert.equal((await run('s')).canRollback,true)
  // The save decides availability; a surface that lost the round is repaired on rollback.
  session.surface.nodes=[]
  const lost=await run('s')
  assert.equal(lost.canRollback,true)
  assert.equal(lost.rollbackUnavailableReason,'')
  session.surface.nodes=[0,1]
  assert.equal((await run('s')).canRollback,true)
  // Rollback resumes an unloaded session itself.
  loaded=false
  assert.equal((await run('s')).canRollback,true)
})

test('已结算剧情进入摘要后，失败尾部的清除入口仍可用', () => {
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 2 } },
    { seq: 1, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '行动' }] } },
    { seq: 2, type: 'assistant/message', surfaceOp: 'append', data: { turn: 2, message: { source: { kind: 'model' }, content: [{ type: 'text', text: '正文' }] } } },
    { seq: 3, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    { seq: 4, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1, 2], data: { source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: '摘要' }] } },
    { seq: 5, type: 'turn/start', data: { turn: 3 } },
    { seq: 6, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '失败输入' }] } },
    { seq: 7, type: 'turn/end', data: { turn: 3, reason: { kind: 'error' } } }
  ]
  const session = { id: 's', events, surface: { nodes: [4, 6] } }
  const fields = createSessionStateView({ activity: () => ({ busy: false }), evidence: () => ({ session, events, nodes: session.surface.nodes }) })
  const chat = { id: 'c', sessionId: 's', mode: 'story', messages: [{ role: 'user', text: '行动' }, { role: 'assistant', turn: 2, text: '正文' }] }
  const view = fields.rollback(chat)
  assert.equal(view.canClearIncompleteReply, true)
  assert.equal(view.canRollback, true)
})
