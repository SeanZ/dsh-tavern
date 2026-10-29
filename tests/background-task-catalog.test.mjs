import assert from 'node:assert/strict'
import test from 'node:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { BACKGROUND_TASK_CATALOG } from '../tavern-plugin/lib/domain/background-task-catalog.js'

async function sources(dir) {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'client.js') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await sources(path))
    else if (entry.name.endsWith('.js')) files.push(path)
  }
  return files
}

test('every background task kind the code runs is listed in the catalog', async () => {
  const listed = new Set(BACKGROUND_TASK_CATALOG.map(item => item.task))
  const used = new Set()
  for (const file of await sources(new URL('../tavern-plugin/lib', import.meta.url).pathname)) {
    for (const match of (await readFile(file, 'utf8')).matchAll(/\btask: *'([a-z-]+)'/g)) used.add(match[1])
  }
  // Sub-agents the foreground spawns are not background runner tasks.
  used.delete('subagent')
  assert.ok(used.size >= 8)
  assert.deepEqual([...used].filter(task => !listed.has(task)), [])
  for (const item of BACKGROUND_TASK_CATALOG) {
    assert.ok(item.name && item.does && item.trigger && ['resident', 'ephemeral'].includes(item.lane), item.task)
  }
})
