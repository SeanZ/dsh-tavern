import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import bubbleLine from '../tavern-plugin/src/client/bubble-line.cjs'
import { stageDisplayUnits } from '../tavern-plugin/lib/domain/stage-display-units.js'
import { createBodyRenderPlan } from '../tavern-plugin/lib/domain/body-renderer.js'

const bubble = '@bubble:guest|访客|平静|[真实对话]'
const example = '@bubble:example|示例|平静|[代码示例]'
const groupSource = await readFile(new URL('../tavern-plugin/src/client/body-group.js', import.meta.url), 'utf8')
const stageHelpers = await readFile(new URL('../tavern-plugin/src/client/gal-stage-helpers.cjs', import.meta.url), 'utf8')
const historySource = await readFile(new URL('../tavern-plugin/src/client/gal-history.js', import.meta.url), 'utf8')
const paragraphCountSource = historySource.split('\n').find(line => line.startsWith('function galParagraphCount('))
function prepare(text, options = {}) {
  const context = { ...bubbleLine, stagePagePlain: text => text }
  vm.runInNewContext(stageHelpers + '\n' + paragraphCountSource + '\n' + groupSource + ';this.prepare = prepareTavernBodyGroup', context)
  const parts = [{ kind: 'markdown', text }]
  return context.prepare(createBodyRenderPlan({ parts })[0], parts, options)
}

for (const [name, code] of [
  ['反引号围栏', '```text\n' + example + '\n```'],
  ['波浪线围栏', '~~~\n' + example + '\n~~~'],
  ['短围栏不能关闭长围栏', '````\n```\n' + example + '\n````'],
  ['不同围栏不能互相关闭', '```\n~~~\n' + example + '\n```'],
  ['缩进代码', '    ' + example],
  ['列表内围栏', '- 示例\n\n    ```text\n    ' + example + '\n    ```'],
  ['列表续行代码引用', '- 示例\n    ```text\n    ' + example + '\n    ```'],
  ['段落续行代码引用', '普通段落\n    ```text\n    ' + example + '\n    ```'],
  ['跨行行内代码', '`代码示例\n' + example + '\n结束`'],
]) test(name + '：正文槽、共享解析和服务端舞台均保留代码字面量', () => {
  const text = code + '\n\n' + bubble
  assert.deepEqual(bubbleLine.parseBubbles(text).filter(row => row.kind === 'bubble').map(row => row.alias), ['guest'])
  assert.deepEqual(stageDisplayUnits([{ kind: 'markdown', text }]).filter(row => row.kind === 'line').map(row => row.alias), ['guest'])
  const prepared = prepare(text)
  assert.equal(prepared.slots.length, 1)
  assert.ok(prepared.text.includes(code))
  assert.equal(Object.keys(prepared.sources[0].targets).length, 1)
})

test('流式未闭合围栏不生成气泡，旧整行引号气泡继续工作', () => {
  const text = '```\n' + example
  assert.equal(bubbleLine.parseBubbles(text, true).filter(row => row.kind === 'bubble').length, 0)
  assert.equal(prepare(text, { streaming: true }).slots.length, 0)
  assert.equal(bubbleLine.parseBubbles('`' + bubble + '`')[0].alias, 'guest')
})

for (const indent of ['    ', '\t']) test('段落续行气泡与全文解析一致：' + JSON.stringify(indent), () => {
  const text = '旁白一句\n' + indent + example + '\n' + bubble
  const segments = bubbleLine.parseBubbles(text)
  assert.deepEqual(segments.filter(row => row.kind === 'bubble').map(row => row.alias), ['example', 'guest'])
  assert.deepEqual(stageDisplayUnits([{ kind: 'markdown', text }]).filter(row => row.kind === 'line').map(row => row.alias), ['example', 'guest'])
  const prepared = prepare(text)
  assert.equal(prepared.slots.length, 2)
  assert.deepEqual(Object.keys(prepared.sources[0].targets), ['1', '2'])
  assert.equal(prepared.text.includes('@bubble'), false)
})

test('流式气泡短前缀沿用共享解析器隐藏规则，普通提及保持原文', () => {
  for (const prefix of ['@', '@b', '@bu', '@bub', '@bubb', '@bubbl', '@bubble', '@bubble:guest']) {
    assert.equal(prepare('旁白\n'+prefix, { streaming: true }).text, '旁白\n', prefix)
  }
  assert.equal(prepare('@username 请查看').text, '@username 请查看')
  assert.equal(prepare('@bubble:guest|访客|平静|').text, '')
})


test('跨语法组成员的基数沿用真实客户端段落函数，与服务端源单元一致', () => {
  const context = { ...bubbleLine, stagePagePlain: text => text }
  vm.runInNewContext(stageHelpers + '\n' + paragraphCountSource + '\n' + groupSource + ';this.prepare = prepareTavernBodyGroup', context)
  const parts = [{kind:'markdown',text:'第一段\n\n'+bubble+'\n最后一段\n\n'}, {kind:'html',content:'<span>行内标记</span>'}, {kind:'markdown',text:'\n\n下一段\n'+bubble}]
  const groups=createBodyRenderPlan({parts})
  const prepared=context.prepare(groups[0],parts,{})
  assert.deepEqual(Array.from(prepared.sources,source=>source.base),[0,stageDisplayUnits(parts.slice(0,2)).length])
  assert.deepEqual(Array.from(prepared.sources,source=>source.member.frameIndex),[0,2])
  assert.deepEqual(Array.from(prepared.sources,source=>source.member.sourcePartIndex),[0,2])
})

test('气泡在连续叙述间生成独立块槽，流式与完成态顺序相同',()=>{
 for(const streaming of [true,false]){
  const prepared=prepare('前文\n'+bubble+'\n后文',{streaming})
  assert.match(prepared.text,/前文\n{2,}<span data-dsh-body-slot="[^"]+"><\/span>\n{2,}后文/)
 }
})

test('媒体锚点落在退化气泡行中仍挂一次，不被文本替换吞掉',()=>{
 const text='@bubble:guest|访客|[看这张图]';const at=text.indexOf('图')
 const prepared=prepare(text,{plugin:{prepareBody:()=>[{start:at,end:at,node:'media',block:true}]}})
 assert.equal(prepared.slots.length,1)
 assert.equal(prepared.slots[0].node,'media')
 assert.ok(prepared.text.includes('看这张图'))
})

test('跨气泡边界的插件匹配不丢弃已有气泡挂点',()=>{
 const text='前文\n'+bubble+'\n后文'
 const prepared=prepare(text,{plugin:{prepareBody:()=>[{start:0,end:text.indexOf('对话'),node:'marker'}]}})
 assert.equal(prepared.slots.length,2)
 for(const id of Object.values(prepared.sources[0].targets))assert.ok(prepared.slots.some(slot=>slot.id===id))
 assert.equal(prepared.slots.filter(slot=>slot.node==='marker').length,1)
})

test('重定位到气泡之后的块媒体独立占位，不吞入下一段',()=>{
 const text=bubble+'\n后文',at=text.indexOf('对话')
 const prepared=prepare(text,{plugin:{prepareBody:()=>[{start:at,end:at+2,node:'media',block:true}]}})
 const media=prepared.slots.find(slot=>slot.node==='media')
 assert.equal(media.isolated,true)
 assert.ok(prepared.text.includes('<span data-dsh-body-slot="'+media.id+'"></span>\n\n'))
})
