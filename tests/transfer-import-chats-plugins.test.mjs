import assert from 'node:assert/strict'
import test from 'node:test'

import { createTransferImport } from '../tavern-plugin/lib/domain/transfer-import.js';

function manifestWith(parts) {
  return { spec: 'dsh-tavern.transfer', version: 1, name: 't', parts };
}

function baseImport(overrides = {}) {
  return createTransferImport(Object.assign({
    fileResources: { async list() { return [] }, async readText() { return undefined } },
    worldBooks: { async catalog() { return { standalone: [] } }, async import() { throw new Error('unused') } },
    presetLibrary: { async catalog() { return { presets: [] } }, async import() { throw new Error('unused') } },
    promptDocuments: { import() { throw new Error('unused') } },
    userPreferenceProfile: { async read() { return { profiles: [] } }, async manage() { throw new Error('unused') } },
    regexManager: { async read() { return { global: [] } } },
    readTavernSettings: () => ({ promptSets: { sets: [] } }),
    updateTavernSettings: async () => ({}),
    importCard: async () => ({}),
    importPreset: async () => ({}),
    backup: async () => ''
  }, overrides));
}

test('导入对话走 importOne，并记录新 chatId', async () => {
  const calls = [];
  const importer = baseImport({
    chats: {
      async importOne({ title, content }) { calls.push({ title, size: content.length }); return { chatId: 'chat-new', sessionId: 's-new', title } }
    }
  });
  const files = new Map([['parts/chats/game.dshsave', Buffer.from('save-bytes')]]);
  const result = await importer.apply({
    manifest: manifestWith([{ kind: 'chats', label: '对话与存档', items: [{ key: 'chat-old', title: '雨中列车', entry: 'parts/chats/game.dshsave', bytes: 10, sha256: '' }] }]),
    files
  });
  assert.equal(result.results[0].added, 1);
  assert.deepEqual(calls, [{ title: '雨中列车', size: 10 }]);
  assert.deepEqual(result.results[0].chatIds, ['chat-new']);
});

test('导入插件写入新文件夹；同名文件夹在预览里提示加序号', async () => {
  const calls = [];
  const importer = baseImport({
    plugins: {
      async list() { return [{ key: 'dsh-tavern-rewrite', title: '重写', bytes: 1 }] },
      async importOne({ key, title, content }) { calls.push({ key, title, size: content.length }); return { folder: key + ' (2)' } }
    }
  });
  const manifest = manifestWith([{ kind: 'plugins', label: '插件', items: [{ key: 'dsh-tavern-rewrite', title: '重写', entry: 'parts/plugins/dsh-tavern-rewrite.zip', bytes: 4, sha256: '' }] }]);
  const preview = await importer.preview(manifest);
  assert.equal(preview.parts[0].conflicts, 1);
  assert.match(preview.parts[0].items[0].reason, /会加序号/);

  const result = await importer.apply({ manifest, files: new Map([['parts/plugins/dsh-tavern-rewrite.zip', Buffer.from('zip!')]]) });
  assert.equal(result.results[0].added, 1);
  assert.deepEqual(calls, [{ key: 'dsh-tavern-rewrite', title: '重写', size: 4 }]);
});

test('对话不会判定为冲突：导入总是新建一局', async () => {
  const importer = baseImport({
    chats: { async importOne() { return { chatId: 'x' } } }
  });
  const manifest = manifestWith([{ kind: 'chats', label: '对话与存档', items: [{ key: 'chat-1', title: '作家 · 第 3 章', entry: 'parts/chats/a.dshsave', bytes: 1, sha256: '' }] }]);
  const preview = await importer.preview(manifest);
  assert.equal(preview.parts[0].conflicts, 0);
  assert.equal(preview.parts[0].items[0].conflict, false);
});

test('导入剧本素材走 unique 写入，同名在预览里提示加序号', async () => {
  const calls = [];
  const importer = baseImport({
    materials: {
      async list() { return [{ key: 'materials/设定.md', title: '设定', meta: '资料', bytes: 3 }] },
      async importOne({ title, content }) { calls.push({ title, size: content.length }); return { path: 'materials/设定 (1).md' } }
    }
  });
  const manifest = manifestWith([{ kind: 'scripts', label: '剧本与素材', items: [{ key: 'materials/设定.md', title: '设定', entry: 'parts/scripts/设定.md', bytes: 3, sha256: '' }] }]);
  const preview = await importer.preview(manifest);
  assert.equal(preview.parts[0].conflicts, 1);
  const result = await importer.apply({ manifest, files: new Map([['parts/scripts/设定.md', Buffer.from('abc')]]) });
  assert.equal(result.results[0].added, 1);
  assert.deepEqual(calls, [{ title: '设定', size: 3 }]);
});

test('导入字体走 importOne，并接受返回的新 id', async () => {
  const calls = [];
  const importer = baseImport({
    fonts: {
      async list() { return [{ key: 'noto-sans', title: 'Noto Sans', meta: '2 个字重', bytes: 10 }] },
      async importOne({ key, content }) { calls.push({ key, size: content.length }); return { id: key + '-2' } }
    }
  });
  const manifest = manifestWith([{ kind: 'fonts', label: '字体', items: [{ key: 'noto-sans', title: 'Noto Sans', entry: 'parts/fonts/noto-sans.zip', bytes: 4, sha256: '' }] }]);
  const preview = await importer.preview(manifest);
  assert.equal(preview.parts[0].conflicts, 1);
  const result = await importer.apply({ manifest, files: new Map([['parts/fonts/noto-sans.zip', Buffer.from('zip!')]]) });
  assert.equal(result.results[0].added, 1);
  assert.deepEqual(calls, [{ key: 'noto-sans', size: 4 }]);
});

test('插件数据走 importOne 并计入覆盖', async () => {
  const calls = [];
  const importer = baseImport({
    pluginData: {
      async list() { return [{ key: 'dsh-runninghub', title: 'RunningHub', meta: '插件数据', bytes: 8 }] },
      async importOne({ key, content }) { calls.push({ key, size: content.length }); return { plugin: key, redacted: true } }
    }
  });
  const manifest = manifestWith([{ kind: 'plugin-data', label: '插件数据', items: [{ key: 'dsh-runninghub', title: 'RunningHub', entry: 'parts/plugin-data/dsh-runninghub.json', bytes: 5, sha256: '' }] }]);
  const preview = await importer.preview(manifest);
  assert.equal(preview.parts[0].overwriteAllowed, true);
  const result = await importer.apply({ manifest, files: new Map([['parts/plugin-data/dsh-runninghub.json', Buffer.from('{}')]]) });
  assert.equal(result.results[0].overwritten, 1);
  assert.deepEqual(calls, [{ key: 'dsh-runninghub', size: 2 }]);
});

test('写作 Skill 走 importOne，重名在预览里提示', async () => {
  const calls = [];
  const importer = baseImport({
    skills: {
      async list() { return [{ key: 'noir', title: 'noir', meta: '写作 Skill', bytes: 4 }] },
      async importOne({ key, content }) { calls.push({ key, size: content.length }); return { name: 'noir-2' } }
    }
  });
  const manifest = manifestWith([{ kind: 'skills', label: '写作 Skill', items: [{ key: 'noir', title: 'noir', entry: 'parts/skills/noir.zip', bytes: 4, sha256: '' }] }]);
  const preview = await importer.preview(manifest);
  assert.equal(preview.parts[0].conflicts, 1);
  const result = await importer.apply({ manifest, files: new Map([['parts/skills/noir.zip', Buffer.from('zip!')]]) });
  assert.equal(result.results[0].added, 1);
  assert.deepEqual(calls, [{ key: 'noir', size: 4 }]);
});

test('只导入勾选的条目，未勾选的按跳过计', async () => {
  const importer = baseImport({
    importCard: async payload => { return { path: 'cards/' + payload.name } }
  });
  const manifest = manifestWith([{ kind: 'cards', label: '人物卡', items: [
    { key: 'cards/a.json', title: 'A', entry: 'parts/cards/a.json', bytes: 1, sha256: '' },
    { key: 'cards/b.json', title: 'B', entry: 'parts/cards/b.json', bytes: 1, sha256: '' }
  ] }]);
  const files = new Map([
    ['parts/cards/a.json', Buffer.from('{"name":"A"}')],
    ['parts/cards/b.json', Buffer.from('{"name":"B"}')]
  ]);
  const result = await importer.apply({ manifest, files, selection: { cards: ['cards/a.json'] } });
  assert.equal(result.results[0].added, 1);
  assert.equal(result.results[0].skipped, 1);
});

test('单条损坏只记失败，其他条目照常导入', async () => {
  const importer = baseImport({
    importCard: async payload => { return { path: 'cards/' + payload.name } }
  });
  const manifest = manifestWith([{ kind: 'cards', label: '人物卡', items: [
    { key: 'cards/bad.json', title: '坏卡', entry: 'parts/cards/bad.json', bytes: 1, sha256: '', usable: false },
    { key: 'cards/good.json', title: '好卡', entry: 'parts/cards/good.json', bytes: 1, sha256: '' }
  ] }]);
  const result = await importer.apply({ manifest, files: new Map([['parts/cards/good.json', Buffer.from('{"name":"好卡"}')]]) });
  assert.equal(result.results[0].added, 1);
  assert.deepEqual(result.results[0].failed.map(row => row.title), ['坏卡']);
});

test('对话存档按内容哈希去重：同一份存档第二次跳过', async () => {
  const crypto = await import('node:crypto');
  const save = Buffer.from('same save bytes');
  const hash = crypto.createHash('sha256').update(save).digest('hex');
  let imports = 0;
  const importer = baseImport({
    chats: {
      async importedHashes() { return imports > 0 ? new Set([hash]) : new Set() },
      async importOne({ title, content, sha256 }) { imports += 1; return { chatId: 'chat-new', sessionId: 's', title, sha256 } }
    }
  });
  const manifest = manifestWith([{ kind: 'chats', label: '对话与存档', items: [{ key: 'chat-old', title: '作家', entry: 'parts/chats/a.dshsave', bytes: 15, sha256: '' }] }]);
  const files = new Map([['parts/chats/a.dshsave', save]]);
  const first = await importer.apply({ manifest, files });
  assert.equal(first.results[0].added, 1);
  const second = await importer.apply({ manifest, files });
  assert.equal(second.results[0].added, 0);
  assert.equal(second.results[0].skipped, 1);
});
