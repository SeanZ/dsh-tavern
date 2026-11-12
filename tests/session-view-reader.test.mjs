import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionViewReader } from '../tavern-plugin/lib/domain/session-view-reader.js'
import { projectionFixture } from './fixtures/session-view-projection.mjs'
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}}
function fixture() {
  let chat={id:'c',sessionId:'s',mode:'story',cardPath:'card',_storageRevision:1,messages:[{role:'assistant',text:'one'}]}
  const calls={fullRead:0,full:0,dirty:0,cached:0},states=[]
  const deps={readState:async()=>chat && {...structuredClone(chat),messages:[]},readChat:async()=>{calls.fullRead++;return structuredClone(chat)},
    readChanges:async()=>({revision:chat._storageRevision,indices:[0]}),
    project:{full:async value=>{calls.full++;return {chatId:value.id,tavernHelper:{messages:structuredClone(value.messages)}}},
      dirty:async value=>{calls.dirty++;return {chatId:value.id,tavernHelper:{messages:structuredClone(value.messages)}}},
      cached:async(_value,previous)=>{calls.cached++;return previous}},
    activity:()=>({busy:false}),foregroundRunning:()=>false,trace:{stage:(_name,fn)=>fn(),state:state=>states.push(state)},
    synchronize:(_id,view,_cursor,options)=>({view,...options})}
  // Closures let the tests replace adapters at the actual asynchronous seam.
  const reader=createSessionViewReader({...deps,readState:(...args)=>deps.readState(...args),readChat:(...args)=>deps.readChat(...args),readChanges:(...args)=>deps.readChanges(...args),readViewDelta:(...args)=>deps.readViewDelta?.(...args)})
  return {reader,deps,calls,states,get chat(){return chat},set chat(value){chat=value}}
}
for (const changes of [undefined,{revision:99,indices:[0]}]) test(`missing or mismatched change coverage rebuilds the full view: ${JSON.stringify(changes)}`,async()=>{
  const f=fixture();await f.reader.read('s');f.chat={...f.chat,_storageRevision:2}
  f.deps.readChanges=async()=>changes
  await f.reader.read('s');assert.equal(f.calls.full,2);assert.equal(f.calls.dirty,0)
})
for(const row of [{role:'user',text:'role changed'},null])test(`structural history changes retain full fallback: ${JSON.stringify(row)}`,async()=>{
  const f=fixture();await f.reader.read('s');f.chat={...f.chat,_storageRevision:2,messages:row?[row]:[]}
  await f.reader.read('s');assert.equal(f.calls.full,2);assert.equal(f.calls.dirty,0)
})

for (const kind of ['revision', 'resource', 'missing']) test(`invalid delta ${kind} falls back before rendering`,async()=>{
  const f=fixture();await f.reader.read('s');f.chat={...f.chat,_storageRevision:2}
  f.deps.readViewDelta=async()=>kind==='missing'?undefined:{baseRevision:1,revision:kind==='revision'?3:2,indices:[0],chat:{...f.chat,cardPath:kind==='resource'?'other':'card'}}
  await f.reader.read('s')
  assert.equal(f.calls.fullRead,2)
})

test('同版本窗口的并发刷新共享一次投影', async () => {
  const release = gate()
  let projections = 0
  const window = {revision:1,from:4,to:4,messageCount:5,chat:{id:'c',sessionId:'s',messages:[{role:'assistant'}]}}
  const reader = createSessionViewReader({
    readOpeningWindow:async () => window,
    project:{opening:async () => { projections++; await release.promise; return {chatId:'c'} }},
    trace:{stage:(_name,fn) => fn(),state() {}},synchronize:(_id,view) => ({view})
  })
  const request = {sessionId:'s',openingWindow:1,viewSync:1}
  const first = reader.response(request), second = reader.response(request)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(projections, 1)
  release.resolve()
  await Promise.all([first,second])
  assert.equal(projections, 1)
})

test('同版本窗口重读反映宿主挂接和结算状态变化', async () => {
  let loaded = false, busy = false
  const session = { id:'s', events:[], surface:{nodes:[]} }
  const f = projectionFixture({
    activityOf:() => ({busy,phase:busy ? 'running' : 'idle',role:'settlement'}),
    sessionStore:{get:() => loaded ? session : undefined},
    sessionDebugEvidence:() => ({loaded,events:session.events,session:loaded ? session : undefined})
  })
  const window = {chat:f.chat,revision:1,from:20,to:20,messageCount:21}
  const reader = createSessionViewReader({
    readOpeningWindow:async () => window,project:f.projection.project,
    trace:{stage:(_name,fn) => fn(),state() {}},synchronize:(_id,view) => ({view})
  })
  const request = {sessionId:'s',openingWindow:1,viewSync:1}
  const first = (await reader.response(request)).view
  assert.equal(first.activity.phase,'idle')
  assert.equal(first.transcriptTurns,null)
  loaded = true
  busy = true
  const next = (await reader.response(request)).view
  assert.equal(next.activity.phase,'running')
  assert.equal(next.activity.busy,true)
  assert.deepEqual(next.railTurns,[])
  assert.notEqual(next.transcriptTurns,null)
  busy = false
  assert.equal((await reader.response(request)).view.activity.phase,'idle')
})

test('不可用窗口按 revision 负缓存，版本前进后重新判定并可切换窗口', async () => {
  let chat = {id:'c',sessionId:'s',mode:'story',_storageRevision:1,messages:[{role:'assistant',text:'正文'}]}
  let openingReads = 0, fullReads = 0, available = false
  const reader = createSessionViewReader({
    readState:async () => ({...chat,messages:[]}),
    readChat:async () => { fullReads++; return structuredClone(chat) },
    readChanges:async () => ({revision:chat._storageRevision,indices:[0]}),
    readOpeningWindow:async () => {
      openingReads++
      return available ? {revision:chat._storageRevision,from:0,to:0,messageCount:1,chat} : null
    },
    project:{
      full:async value => ({revision:value._storageRevision}),
      cached:async (_value,previous) => previous,
      dirty:async value => ({revision:value._storageRevision}),
      opening:async value => ({revision:value.revision,window:true})
    },
    activity:() => ({}),foregroundRunning:() => false,
    trace:{stage:(_name,fn) => fn(),state() {}},synchronize:(_id,view) => ({view})
  })
  const request = {sessionId:'s',openingWindow:1,viewSync:1}
  await reader.response(request)
  await reader.response(request)
  assert.equal(openingReads,1,'同版本不再重复读取已知不可用的窗口')
  assert.equal(fullReads,1,'第二次仍复用完整视图缓存')
  chat = {...chat,_storageRevision:2}
  await reader.response(request)
  assert.equal(openingReads,2,'revision 变化必须重新判定')
  chat = {...chat,_storageRevision:3}
  available = true
  const response = await reader.response(request)
  assert.equal(openingReads,3)
  assert.equal(response.view.window,true)
  assert.equal(fullReads,2,'可用窗口直接返回，不再补完整整读')
})

for(const request of [{viewSync:1},{viewSync:1,openingWindow:1,fullView:true}])test('legacy clients and explicit complete reads never receive a window: '+JSON.stringify(request),async()=>{
 const reader=createSessionViewReader({readOpeningWindow:()=>{throw Error('must keep complete contract')},readState:async()=>undefined,
  project:{opening:()=>{throw Error('unexpected')}},trace:{stage:(_name,fn)=>fn()},synchronize:(_id,view)=>({view})})
 assert.equal((await reader.response({sessionId:'s',...request})).view,null)
})

for (const enabled of [false, true]) test(`无 Helper 历史可增量复用，新启用 MVU 仍完整重建: ${enabled}`, async () => {
  const f = fixture()
  f.deps.project.full = async value => {
    f.calls.full++
    return { chatId:value.id, tavernHelper:value.mvu?.enabled === true
      ? { stateRevision:value._storageRevision, messages:structuredClone(value.messages) } : null }
  }
  f.deps.project.dirty = async (value, previous, _indices, _activity, options) => {
    f.calls.dirty++
    assert.equal(options.baseRevision, 1)
    return { ...previous, dirty:true }
  }
  await f.reader.read('s')
  f.chat = {...f.chat, _storageRevision:2, mvu:{enabled}}
  f.deps.readViewDelta = async () => ({baseRevision:1, revision:2, indices:[0], chat:f.chat})
  const view = await f.reader.read('s')
  assert.equal(f.calls.fullRead, enabled ? 2 : 1)
  assert.equal(f.calls.full, enabled ? 2 : 1)
  assert.equal(f.calls.dirty, enabled ? 0 : 1)
  assert.equal(view.dirty === true, !enabled)
})

for (const fields of [undefined, ['openingWorldbookSnapshot'], ['cardDefinitionSnapshot']]) test(`resource snapshot changes rebuild deferred capabilities: ${fields}`, async () => {
  const f = fixture(), project = f.deps.project.full
  f.deps.project.full = async chat => ({...await project(chat), cardResourceAccess:{revision:chat._storageRevision}})
  await f.reader.read('s', {deferResources:true})
  f.chat = {...f.chat, _storageRevision:2}
  f.deps.readViewDelta = async () => ({baseRevision:1,revision:2,indices:[],changedHeaderFields:fields,chat:f.chat})
  const view = await f.reader.read('s', {deferResources:true})
  assert.equal(view.cardResourceAccess.revision, 2)
  assert.equal(f.calls.dirty, 0)
})

test('新客户端只接收一份世界书；旧客户端与缓存原视图保留兼容字段', async () => {
  const f = fixture()
  const worldbook = { name: '世界书', entries: [{ content: '长内容'.repeat(1000) }] }
  f.deps.project.full = async () => ({ tavernHelper: { messages: [], worldbook }, tavernHelperWorldbook: worldbook })
  const modern = await f.reader.response({ sessionId: 's', helperWorldbookSync: 1 })
  assert.equal(modern.view.tavernHelper.worldbook, worldbook)
  assert.equal(Object.hasOwn(modern.view, 'tavernHelperWorldbook'), false)
  const old = await f.reader.response({ sessionId: 's' })
  assert.equal(old.view.tavernHelperWorldbook, worldbook)
  assert.ok(JSON.stringify(old).length > JSON.stringify(modern).length + 2000)
})


test('手动刷新完整重读同版本存档、合并点击并禁止旧在途读取覆盖', async () => {
 const f=fixture(), started=gate(), blocked=gate(), invalidated=[]
 f.deps.project.invalidate=id=>invalidated.push(id)
 const full=f.deps.project.full
 let first=true
 f.deps.project.full=async (chat,options)=>{
  if(first){first=false;started.resolve();await blocked.promise}
  if(options.displayOnly)assert.equal(options.windowHelperMessages,undefined)
  return full(chat)
 }
 const old=f.reader.read('s');await started.promise
 f.chat.messages[0].text='重算正文'
 const fresh=f.reader.refresh('s')
 assert.equal(f.reader.refresh('s'),fresh)
 const later=f.reader.read('s')
 blocked.resolve();await old
 const result=await fresh
 assert.equal(result.tavernHelper.messages[0].text,'重算正文')
 assert.ok(result.displayRevision>0)
 assert.equal((await later).displayRevision,result.displayRevision)
 assert.deepEqual(invalidated,['c'])
 assert.equal(f.calls.fullRead,2)
})

test('刷新拒绝生成中的会话，计算时存档变化则不缓存过期结果', async () => {
 const f=fixture()
 f.deps.project.invalidate=()=>{}
 f.chat.settleStatus='running'
 await assert.rejects(f.reader.refresh('s'),/正在生成或结算/)
 f.chat.settleStatus='idle'
 const full=f.deps.project.full
 f.deps.project.full=async (chat,options)=>{
  const view=await full(chat)
  if(options.displayOnly){f.chat={...f.chat,_storageRevision:2};f.chat.messages[0].text='后续正文'}
  return view
 }
 await assert.rejects(f.reader.refresh('s'),/已有变化/)
 assert.equal((await f.reader.read('s')).tavernHelper.messages[0].text,'后续正文')
 await assert.rejects(f.reader.refresh(''),/sessionId/)
})


test('显示刷新等待本会话窗口投影并只失效本会话增量投影', async () => {
  const started = gate(), release = gate()
  let text = '旧正文', block = false
  const counts = new Map(), invalidated = []
  const chat = id => ({id:'chat-'+id,sessionId:id,mode:'story',_storageRevision:1,messages:[]})
  const reader = createSessionViewReader({
    readState:async id => chat(id),readChat:async id => chat(id),
    readOpeningWindow:async id => ({chat:chat(id),revision:1,from:0,to:0,messageCount:1}),
    project:{
      opening:async window => {
        const id = window.chat.sessionId, value = id === 's' ? text : '另一局正文'
        counts.set(id,(counts.get(id)||0)+1)
        if(block && id==='s'){started.resolve();await release.promise}
        return {text:value}
      },
      full:async () => ({text}),invalidate:id => invalidated.push(id)
    },
    trace:{stage:(_name,fn)=>fn(),state(){}},activity:()=>({busy:false}),foregroundRunning:()=>false,
    synchronize:(_id,view)=>({view})
  })
  const request = id => ({sessionId:id,openingWindow:1,viewSync:1})
  await reader.response(request('other'))
  block = true
  const old = reader.response(request('s'));await started.promise
  text = '新正文'
  const refresh = reader.refresh('s'), next = reader.response(request('s'))
  release.resolve();await old;await refresh
  assert.equal((await next).view.text,'新正文')
  assert.equal(counts.get('s'),2)
  assert.equal(counts.get('other'),1)
  assert.deepEqual(invalidated,['chat-s'])
  assert.equal((await reader.response(request('other'))).view.text,'另一局正文')
})
