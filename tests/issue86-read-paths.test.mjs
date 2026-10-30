import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatJournalStore } from '../tavern-plugin/lib/domain/chat-journal-store.js'
import { createChatPersistence } from '../tavern-plugin/lib/domain/chat-persistence.js'

test('change indices carry exact revision, detach results and survive more than 32 commits', async t => {
  const root = await mkdtemp(join(tmpdir(),'issue86-changes-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const store = createChatJournalStore({dataRoot:root})
  const persistence = createChatPersistence({store})
  await store.update('c',()=>({id:'c',_storageRevision:1,messages:[{text:'a'},{text:'b'}]}))
  for(let revision=1;revision<=40;revision++) await store.patch('c',revision,[
    {op:'set',path:['_storageRevision'],value:revision+1},
    {op:'set',path:['messages',revision%2,'text'],value:String(revision)}
  ])
  const changed = await persistence.readChangedIndices('c',1)
  assert.deepEqual(changed,{indices:[0,1],baseRevision:1,revision:41})
  changed.indices.length=0
  assert.deepEqual((await persistence.readChangedIndices('c',1)).indices,[0,1])
  assert.deepEqual((await store.readChangedSlice('c',1)).indices,[0,1])
  assert.equal(await store.readChangedIndices('c',0),undefined)
  assert.equal(await createChatJournalStore({dataRoot:root}).readChangedIndices('c',1),undefined)
  await store.patch('c',41,[{op:'set',path:['_storageRevision'],value:42},
    {op:'splice',path:['messages'],index:0,deleteCount:1,items:[]}])
  assert.deepEqual((await store.readChangedIndices('c',1)).indices,[0])
  assert.equal((await store.readChangedSlice('c',1)).chat.messages[0].text,'39')
})
