import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createFloorSnapshots } from '../tavern-plugin/lib/story/floor-snapshots.js';
import { BODY_RENDER_VERSION } from '../tavern-plugin/lib/domain/body-renderer.js';

test('真实磁盘：旧版本快照不命中，旧页面不能写成新版本，正确版本冷读保留', async t => {
  const root=await mkdtemp(join(tmpdir(),'body-snapshot-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store={
    readJson: async path=>JSON.parse(await readFile(join(root,path),'utf8')),
    writeJson:async(path,data)=>{await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),JSON.stringify(data));},
    list: async path=>(await readdir(join(root,path),{withFileTypes:true}).catch(()=>[])).map(entry=>({name:entry.name,directory:entry.isDirectory()})),
    remove:async path=>rm(join(root,path),{force:true})
  };
  const open=()=>createFloorSnapshots({store,chatIdFor:async()=> 'test'});
  await store.writeJson('floor-snapshots/test/2.json',{version:1,turn:2,reply:'reply',html:'旧快照'});
  assert.deepEqual((await open().read({sessionId:'s',turns:[2]})).snapshots,{});
  assert.ok(Number.isInteger(BODY_RENDER_VERSION));
  for(const rendererVersion of [undefined,BODY_RENDER_VERSION-1,BODY_RENDER_VERSION+1]) await assert.rejects(
    open().save({sessionId:'s',turn:2,reply:'reply',html:'错误版本',rendererVersion}),
    error=>error.code==='BODY_RENDER_VERSION_MISMATCH'
  );
  assert.equal(JSON.parse(await readFile(join(root,'floor-snapshots/test/2.json'),'utf8')).html,'旧快照');
  await store.writeJson('floor-snapshots/test/3.json',{version:1,rendererVersion:BODY_RENDER_VERSION+1,turn:3,reply:'r',html:'未来版本'});
  await writeFile(join(root,'floor-snapshots/test/4.json'),'{broken');
  assert.deepEqual((await open().read({sessionId:'s',turns:[3,4]})).snapshots,{});
  await open().save({sessionId:'s',turn:2,reply:'reply',html:'新快照',rendererVersion:BODY_RENDER_VERSION});
  const saved=(await open().read({sessionId:'s',turns:[2]})).snapshots[2];
  assert.equal(saved.html,'新快照'); assert.equal(saved.rendererVersion,BODY_RENDER_VERSION);
});
