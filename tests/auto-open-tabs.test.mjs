import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const context = vm.createContext({})
vm.runInContext(fs.readFileSync(new URL('../tavern-plugin/src/client/modules/auto-open-tabs.js', import.meta.url), 'utf8'), context)
const cleared = context.tavernAutoOpenClearedBy
const blankMs = context.TAVERN_AUTO_OPEN_BLANK_MS

const showsPage = context.tavernRightColumnShowsPage
const kinds = ['dsh-tavern:conversation-settings', 'dsh-tavern:status']
const column = (expanded, page) => ({ isExpanded: () => expanded, active: () => page })

test('从 ctx 取右栏控制器，服务缺失或抛错都按「没在看」处理', () => {
  const showing = context.tavernRightColumnShowing
  assert.equal(showing({ get: () => column(true, { kind: 'dsh-tavern:status' }) }, kinds), true)
  assert.equal(showing({ get: () => undefined }, kinds), false)
  assert.equal(showing({ get: () => { throw new Error('no service') } }, kinds), false)
  assert.equal(showing(null, kinds), false)
})
