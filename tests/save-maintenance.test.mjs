import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir } from "node:fs/promises"
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createChatJournalStore} from '../tavern-plugin/lib/domain/chat-journal-store.js'
import {createChatPersistence} from '../tavern-plugin/lib/domain/chat-persistence.js'
import {createSaveMaintenance} from '../tavern-plugin/lib/domain/save-maintenance.js'

const big=n=>'x'.repeat(4096)+n
async function fixture(t,{idle=true,timers,onSave=()=>{}}={}){
 const root=await mkdtemp(join(tmpdir(),'save-maint-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const chats=createChatJournalStore({dataRoot:root,newConversations:true})
 const persistence=createChatPersistence({store:chats})
 const files=new Map(),pruned=[]
 const maintenance=createSaveMaintenance({
  chats,store:{readJson:async p=>structuredClone(files.get(p)),writeJson:async(p,v)=>{files.set(p,structuredClone(v));onSave(p,v)}},
  listChatIds:async()=>(await readdir(join(root,'chats'),{withFileTypes:true})).filter(e=>e.isDirectory()).map(e=>e.name),
  requestLog:{prune:async id=>{pruned.push('requests:'+id)}},recallLog:{prune:async id=>{pruned.push('recalls:'+id)}},
  isIdle:async()=>idle,keepRecent:2,graceMs:0,logger:{log(){},warn(){}},everyRevisions:5,
  ...(timers?{setTimer:(fn,ms)=>{const id={fn,ms};timers.add(id);return id},clearTimer:id=>timers.delete(id)}:{})
 })
 const reopen=()=>createChatPersistence({store:createChatJournalStore({dataRoot:root})})
 return {root,chats,persistence,maintenance,pruned,files,reopen}
}

test('分叉引用的父局版本保留；有任务进行时不整理', async t => {
 const {persistence,maintenance,reopen}=await fixture(t)
 await persistence.write({id:'p',mode:'story',messages:[{role:'assistant',text:big(0)}]})
 for(let i=1;i<=8;i++)await persistence.patch('p',i,[{op:'set',path:['messages',0,'text'],value:big(i)}])
 const parentAt3=await persistence.readRevision('p',3)
 await persistence.write({id:'c',mode:'story',forkedFrom:{chatId:'p',storageRevision:3},messages:[{role:'assistant',text:'fork'}]})
 await maintenance.sweep()
 assert.deepEqual(await reopen().readRevision('p',3),parentAt3)
 const busy=await fixture(t,{idle:false})
 await busy.persistence.write({id:'b',mode:'story',messages:[{role:'assistant',text:big(0)}]})
 assert.equal((await busy.maintenance.maintainChat('b')).status,'busy')
})

test('结算后不立即整理：这一局安静一段时间、期间没有新的结算才整理', {timeout:30000}, async t => {
 const timers=new Set()
 let completed
 const completion=new Promise(resolve=>{completed=resolve})
 const {persistence,maintenance,files}=await fixture(t,{timers,onSave:(_path,value)=>{if(value.compacted?.q===9)completed()}})
 await persistence.write({id:'q',mode:'story',messages:[{role:'assistant',text:big(0)}]})
 for(let i=1;i<=8;i++)await persistence.patch('q',i,[{op:'set',path:['messages',0,'text'],value:big(i)}])
 const compacted=()=>files.get('save-maintenance.json')?.compacted?.q
 maintenance.noteWrite('q',8)
 assert.equal(compacted(),undefined,'结算后不立即整理')
 assert.equal(timers.size,1)
 assert.equal([...timers][0].ms,600000)
 // Another settlement restarts the quiet period.
 maintenance.noteWrite('q',9)
 assert.equal(timers.size,1)
 const [timer]=timers
 timers.delete(timer); timer.fn()
 await completion
 assert.equal(compacted(),9,'安静期满后整理')
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
