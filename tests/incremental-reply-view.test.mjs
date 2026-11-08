import test from 'node:test'
import assert from 'node:assert/strict'
import {createIncrementalReplyView} from '../tavern-plugin/lib/domain/incremental-reply-view.js'
import {projectReplyHistory} from '../tavern-plugin/lib/domain/reply-presentation.js'
import {replyBody} from '../tavern-plugin/lib/domain/round-body.js'
import {projectPersistentStatusView} from '../tavern-plugin/lib/domain/persistent-status-view.js'
const options={charName:'角色',macroState:{userName:'玩家'}}
function reference(chat, opts=options) {
 const history=projectReplyHistory(chat.messages,opts)
 for(const projection of history.projections)projection.body=replyBody(projection,chat)
 return {...projectPersistentStatusView(chat.messages,history.projections,opts),presentation:null,latestSourceBacked:history.latestSourceBacked}
}

test('真实 journal 支持新增/旧正文改写及无消息变化，重启缺少变更证据时回退', async t => {
 const {mkdtemp,rm}=await import('node:fs/promises'), {tmpdir}=await import('node:os'), {join}=await import('node:path')
 const {createChatJournalStore}=await import('../tavern-plugin/lib/domain/chat-journal-store.js')
 const root=await mkdtemp(join(tmpdir(),'incremental-view-'));t.after(()=>rm(root,{recursive:true,force:true}))
 let store=createChatJournalStore({dataRoot:root})
 const cache=createIncrementalReplyView({readChanges:(id,revision)=>store.readChangedSlice(id,revision)})
 let chat=await store.update('chat',()=>({id:'chat',_storageRevision:1,messages:Array.from({length:700},(_,i)=>({role:'assistant',turn:i+1,text:'正文'+i,bodyEdit:true}))}))
 const check=async()=>assert.deepEqual(await cache.project(chat,options,options),reference(chat))
 await check();assert.equal(cache.stats().projectedMessages,700)
 chat=await store.update('chat',current=>({...current,_storageRevision:2,messages:[...current.messages,{role:'assistant',turn:701,text:'新正文',bodyEdit:true}]}))
 await check();assert.equal(cache.stats().projectedMessages,701)
 chat=await store.update('chat',current=>{current._storageRevision++;current.messages[100].text='编辑旧正文';return current})
 await check();assert.equal(cache.stats().projectedMessages,702)
 chat=await store.update('chat',current=>({...current,_storageRevision:4,posture:'更新状态'}))
 await check();assert.equal(cache.stats().projectedMessages,702)
 store=createChatJournalStore({dataRoot:root})
 chat=await store.update('chat',current=>({...current,_storageRevision:5,posture:'重启后'}))
 store=createChatJournalStore({dataRoot:root})
 await check();assert.equal(cache.stats().rebuilt,2)
})

test('正则的 maxDepth 按每一楼自己的深度生效：重美化状态栏只画在最近几楼，新消息进来后旧楼撤掉', async t => {
 const {mkdtemp,rm}=await import('node:fs/promises'), {tmpdir}=await import('node:os'), {join}=await import('node:path')
 const {createChatJournalStore}=await import('../tavern-plugin/lib/domain/chat-journal-store.js')
 const root=await mkdtemp(join(tmpdir(),'incremental-depth-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const store=createChatJournalStore({dataRoot:root})
 const cache=createIncrementalReplyView({readChanges:(id,revision)=>store.readChangedSlice(id,revision)})
 const rule={scriptName:'状态栏美化',findRegex:'<StatusPlaceHolderImpl/>',replaceString:'<div style="color:red">HEAVY</div>',placement:[2],markdownOnly:true,promptOnly:false,maxDepth:2}
 const opts={...options,regexScripts:[rule]}
 const round=turn=>[{role:'user',text:'行动'+turn},{role:'assistant',turn,text:'正文'+turn+'\n\n<StatusPlaceHolderImpl/>'}]
 const heavyTurns=result=>result.projections.filter(p=>p && JSON.stringify(p.parts).includes('HEAVY')).map(p=>p.turn)
 let chat=await store.update('chat',()=>({id:'chat',_storageRevision:1,messages:[1,2,3,4].flatMap(round)}))
 // Depth counts every message after the floor, as in SillyTavern: the latest reply is 0, the one before it 2.
 assert.deepEqual(heavyTurns(await cache.project(chat,opts,opts)),[3,4])
 chat=await store.update('chat',current=>({...current,_storageRevision:2,messages:[...current.messages,...round(5)]}))
 assert.deepEqual(heavyTurns(await cache.project(chat,opts,opts)),[4,5])
 assert.equal(cache.stats().incremental,1,'a new round re-projects only the floors within the bound')
})


test('单会话失效重算同revision的空投影，保留其它会话与有意隐藏规则', async () => {
 const cache=createIncrementalReplyView()
 const chat={id:'refresh',_storageRevision:1,messages:[{role:'assistant',turn:2,text:'正文'}]}
 await cache.project({...chat,messages:[{role:'assistant',turn:2}]},options)
 const other={...chat,id:'other'}
 const kept=await cache.project(other,options,options,{shared:true})
 assert.equal((await cache.project(chat,options)).projections[0].text,'')
 cache.invalidate(chat.id)
 assert.equal((await cache.project(chat,options)).projections[0].text,'正文')
 assert.equal((await cache.project(other,options,options,{shared:true})).projections,kept.projections)
 const hidden={...options,regexScripts:[{findRegex:'正文',replaceString:'',placement:[2],markdownOnly:true}]}
 cache.invalidate(chat.id)
 assert.equal((await cache.project(chat,hidden)).projections[0].text,'')
})

test('失效前迟到的增量任务不能重新污染同版本缓存', async () => {
 let release,entered
 const ready=new Promise(resolve=>{entered=resolve})
 const wait=new Promise(resolve=>{release=resolve})
 const cache=createIncrementalReplyView({readChanges:async()=>{entered();await wait;return undefined}})
 const chat={id:'race',_storageRevision:1,messages:[{role:'assistant',turn:2,text:'旧正文'}]}
 await cache.project(chat,options)
 const old=cache.project({...chat,_storageRevision:2},options)
 await ready
 cache.invalidate(chat.id)
 const fresh={...chat,_storageRevision:2,messages:[{role:'assistant',turn:2,text:'新正文'}]}
 await cache.project(fresh,options)
 release();await old
 assert.equal((await cache.project(fresh,options)).projections[0].text,'新正文')
})
