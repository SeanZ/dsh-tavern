import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir } from "node:fs/promises"
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createChatJournalStore} from '../tavern-plugin/lib/domain/chat-journal-store.js'
import {createChatPersistence} from '../tavern-plugin/lib/domain/chat-persistence.js'
import {createSaveMaintenance} from '../tavern-plugin/lib/domain/save-maintenance.js'

const big=n=>'x'.repeat(4096)+n
async function fixture(t,{idle=true,timers,onSave=()=>{},now}={}){
 const root=await mkdtemp(join(tmpdir(),'save-maint-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const commits=[]
 let maintenance
 // As the host wires it: the store reports every committed revision to maintenance.
 const chats=createChatJournalStore({dataRoot:root,newConversations:true,onCommit:(id,revision)=>{commits.push([id,revision]);maintenance?.noteWrite(id,revision)}})
 const persistence=createChatPersistence({store:chats})
 const files=new Map(),pruned=[]
 maintenance=createSaveMaintenance({
  ...(now?{now}:{}),
  chats,store:{readJson:async p=>structuredClone(files.get(p)),writeJson:async(p,v)=>{files.set(p,structuredClone(v));onSave(p,v)}},
  listChatIds:async()=>(await readdir(join(root,'chats'),{withFileTypes:true})).filter(e=>e.isDirectory()).map(e=>e.name),
  requestLog:{prune:async id=>{pruned.push('requests:'+id)}},recallLog:{prune:async id=>{pruned.push('recalls:'+id)}},
  isIdle:async()=>idle,keepRecent:2,graceMs:0,logger:{log(){},warn(){}},everyRevisions:5,
  ...(timers?{setTimer:(fn,ms)=>{const id={fn,ms};timers.add(id);return id},clearTimer:id=>timers.delete(id)}:{})
 })
 const reopen=()=>createChatPersistence({store:createChatJournalStore({dataRoot:root})})
 t.after(()=>maintenance.dispose())
 return {root,chats,persistence,maintenance,pruned,files,reopen,commits}
}
// Every file of a save's block store (shards and packs), as the disk sees it.
test('每次提交都计入整理（不只是回合结算），一直有写入时最迟两个安静期后整理', {timeout:30000}, async t => {
 const timers=new Set()
 let clock=1000000,completed
 const completion=new Promise(resolve=>{completed=resolve})
 const {persistence,files}=await fixture(t,{timers,now:()=>clock,onSave:(_path,value)=>{if(value.compacted?.w)completed()}})
 await persistence.write({id:'w',mode:'story',messages:[{role:'assistant',text:big(0)}]})
 for(let i=1;i<=6;i++)await persistence.update('w',chat=>({...chat,cardContextRevision:i}))
 assert.equal(timers.size,1,'非回合写入也排上整理')
 assert.equal([...timers][0].ms,600000)
 clock+=900000
 await persistence.update('w',chat=>({...chat,cardContextRevision:7}))
 assert.equal([...timers][0].ms,300000,'不再无限推迟：第一次等待后最迟 20 分钟')
 const [timer]=timers
 timers.delete(timer); timer.fn()
 await completion
 assert.equal(files.get('save-maintenance.json').compacted.w,8)
})

test('启动后补做：积压达到阈值的存档整理，其余不动', {timeout:30000}, async t => {
 const timers=new Set()
 const {persistence,maintenance,files}=await fixture(t,{timers})
 await persistence.write({id:'old',mode:'story',messages:[{role:'assistant',text:big(0)}]})
 for(let i=1;i<=8;i++)await persistence.patch('old',i,[{op:'set',path:['messages',0,'text'],value:big(i)}])
 await persistence.write({id:'small',mode:'story',messages:[{role:'assistant',text:'少'}]})
 timers.clear() // the write notes of this process; a start has none
 maintenance.catchUp()
 assert.equal(timers.size,1)
 const [timer]=timers
 assert.equal(timer.ms,120000,'启动后两分钟：宿主常常重启，等不到十分钟的安静期')
 timers.delete(timer); timer.fn()
 assert.equal((await maintenance.maintainChat('none')).status,'legacy-format') // queued behind the catch-up pass
 assert.equal(files.get('save-maintenance.json').compacted.old,9)
 assert.equal(files.get('save-maintenance.json').compacted.small,undefined,'积压不到阈值的不动')
})

test('整理不在写锁里扫描：整理进行中的写入不必等到整理结束', {timeout:60000}, async t => {
 const {persistence,chats,reopen}=await fixture(t)
 await persistence.write({id:'g',mode:'story',messages:[{role:'assistant',text:big(0)}]})
 for(let i=1;i<=60;i++)await persistence.patch('g',i,[{op:'set',path:['messages',0,'text'],value:big(i)}])
 let compacted=false
 const pass=chats.compact('g',{keepRecent:2,graceMs:0}).then(result=>{compacted=true;return result})
 await persistence.patch('g',61,[{op:'set',path:['messages',0,'text'],value:'中途写入'}])
 assert.equal(compacted,false,'写入没有排在整趟整理之后')
 const result=await pass
 assert.ok(result.removed>0)
 assert.ok(result.lockHolds>=1)
 assert.equal((await reopen().read('g')).messages[0].text,'中途写入')
})

test('默认200回合保留策略经过真实磁盘清理和冷读后仍保留边界快照', {timeout:60000}, async t => {
 const {persistence,maintenance,reopen}=await fixture(t)
 await persistence.write({id:'history-200',mode:'story',messages:[{role:'assistant',turn:1,text:'正文1'}],variables:{hp:1},timeline:{checkpoints:[]}})
 let checkpoints=[]
 for(let turn=2;turn<=205;turn++){
  checkpoints=[...checkpoints,{turn,beforeRevision:turn-1}].slice(-40)
  await persistence.patch('history-200',turn-1,[
   {op:'set',path:['messages',0],value:{role:'assistant',turn,text:'正文'+turn}},
   {op:'set',path:['variables'],value:{hp:turn}},
   {op:'set',path:['timeline','checkpoints'],value:checkpoints}
  ])
 }
 const boundary=await persistence.readRevision('history-200',6)
 const head=await persistence.read('history-200')
 assert.equal((await maintenance.maintainChat('history-200')).status,'done')
 const cold=reopen()
 assert.deepEqual(await cold.readRevision('history-200',6),boundary)
 assert.equal((await cold.readRevision('history-200',100)).variables.hp,100)
 assert.deepEqual(await cold.read('history-200'),head)
 await assert.rejects(cold.readRevision('history-200',4),{code:'DSH_TAVERN_REVISION_NOT_FOUND'})
})
