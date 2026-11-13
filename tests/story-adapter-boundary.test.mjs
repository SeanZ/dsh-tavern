import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { parse } from 'acorn'
import { createStoryServiceAdapter } from '../tavern-plugin/src/client/story/service.js'
import { createStoryRenderAdapter } from '../tavern-plugin/src/client/story/render.js'
import { createBodyRenderPlan } from '../tavern-plugin/lib/domain/body-renderer.js'
import { createStoryRoundsFold, foldStoryRounds, filterStoryRounds } from '../tavern-plugin/lib/story/story-rounds.js'

// 保守的依赖扫描：声明、参数、属性名之外的标识符必须是语言内置值。
// 独立模块测试再执行服务路径，避免靠大包的同名全局意外通过。
const builtins = new Set(['undefined', 'Object', 'Array', 'Number', 'String', 'Boolean', 'Math', 'JSON', 'Promise', 'Error', 'TypeError', 'Set', 'Map', 'WeakMap', 'Date', 'RegExp'])
function freeNames(source) {
  const names = new Set(), references = new Set()
  function binding(node) {
    if (!node) return
    if (node.type === 'Identifier') names.add(node.name)
    else if (node.type === 'ObjectPattern') node.properties.forEach(p => binding(p.type === 'RestElement' ? p.argument : p.value))
    else if (node.type === 'ArrayPattern') node.elements.forEach(binding)
    else if (node.type === 'AssignmentPattern') binding(node.left)
    else if (node.type === 'RestElement') binding(node.argument)
  }
  function visit(node, parent, key) {
    if (!node?.type) return
    if (node.type === 'VariableDeclarator') binding(node.id)
    if (/Function/.test(node.type) || node.type === 'ArrowFunctionExpression') { binding(node.id); node.params.forEach(binding) }
    if (node.type === 'CatchClause') binding(node.param)
    if (node.type === 'Identifier' && !(parent?.type === 'MemberExpression' && key === 'property' && !parent.computed)
      && !(parent?.type === 'Property' && key === 'key' && !parent.computed)
      && parent?.type !== 'ExportSpecifier') references.add(node.name)
    for (const [k,v] of Object.entries(node)) {
      if (Array.isArray(v)) v.forEach(child => visit(child,node,k))
      else if (v && typeof v === 'object') visit(v,node,k)
    }
  }
  visit(parse(source,{ecmaVersion:'latest',sourceType:'module'}))
  return [...references].filter(name => !names.has(name) && !builtins.has(name)).sort()
}
for (const name of ['service','render','transcript']) test('故事 ' + name + ' 适配器没有隐式上游全局依赖', async () => {
  const source = await readFile(new URL('../tavern-plugin/src/client/story/' + name + '.js',import.meta.url),'utf8')
  assert.deepEqual(freeNames(source), [])
})

test('脱离 Tavern 大包运行故事服务：事件折叠与快照 RPC 使用各自注入的实例', async () => {
  const seen = []
  function create(id) {
    const deps = { storyTranscript: { older: async () => false, floors: () => ({ floors: [] }) }, window: { setTimeout, clearTimeout }, createStoryRoundsFold, foldStoryRounds, filterStoryRounds,
      rpc: async (method,args,sessionId) => { seen.push({id,method,args,sessionId}); return {interrupted:true} },
      liveTavernView: {getSnapshot:()=>({view:null})} }
    const {createTavernStoryService} = createStoryServiceAdapter(deps)
    return createTavernStoryService({sessions:{binding:()=>({eventSource:{getSnapshot:()=>({entries:[]})}})},actions:{interactions:{}}})
  }
  assert.equal(create('first').readInterruptedInput('empty'), null)
  await create('first').interruptQueued('one', 3)
  await create('second').interruptQueued('two', 4)
  assert.deepEqual(seen.map(x=>[x.id,x.sessionId,x.args.turn]), [['first','one',3],['second','two',4]])
})

test('脱离 Tavern 大包运行故事渲染投影，复用注入的投影语义', async () => {
  const validation = createStoryServiceAdapter({})
  const projection = {parts:[{kind:'markdown',text:'保留的正文'}]}
  const {createTavernStoryRender} = createStoryRenderAdapter({...validation, createBodyRenderPlan,
    liveTavernView:{getSnapshot:()=>({view:{mode:'story'}})},
    storyTranscript: { older: async () => false, resolve: (_sid, target) => { assert.equal(target.messageUid, 'm2'); return { legacyTurn: 2, projection } } },
    tavernProjectionForTurn:()=>projection, projectionPartsOf:p=>p.parts,tavernLatestProjectionTurn:()=>2})
  const floor = await createTavernStoryRender({}).projectFloor('s',{messageUid:'m2'})
  assert.equal(floor.projection,projection)
  assert.deepEqual(floor.parts,createBodyRenderPlan(projection))
  assert.equal(floor.parts[0].kind,'body')
  assert.equal(floor.parts[0].text,'保留的正文')
  assert.equal(floor.parts[0].members[0].sourcePartIndex,0)
  assert.equal(floor.waitingForHistory,false)
})
