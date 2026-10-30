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
