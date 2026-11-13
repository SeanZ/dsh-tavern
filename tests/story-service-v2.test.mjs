import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, rows, eventWindow, plain, delay } from './fixtures/story-v2.mjs'

const callsOf = (f, method) => f.calls.filter(call => call.method === method).map(call => call.args)

test('v2 列表以逻辑消息为准：重复轮号、零轮号和原生窗口缺失不丢楼层', async t => {
  const messages = rows()
  messages[1].turn = 0
  messages[3].turn = messages[5].turn = 7
  const f = await fixture(t, { messages })
  assert.equal(f.service.apiVersion, 2)
  assert.deepEqual(plain(f.snapshot().floors.map(row => [row.story, row.legacyTurn, row.messageUid])), [[1, null, 'm1'], [2, 7, 'm2'], [3, 7, 'm3']])
  assert.deepEqual(plain(f.snapshot().floors.map(row => row.inputs[0].text)), ['输入1', '输入2', '输入3'])
  await assert.rejects(f.service.regenerate('s1', 3), /消息身份/)
  await assert.rejects(f.service.regenerate('s1', { messageUid: 'missing', messageIndex: 5 }), /已经变化/)
  assert.equal(callsOf(f, 'regenBody').length, 0)
})

test('旧历史分页复用同一消息身份，切局各自保留读取窗口', async t => {
  const f = await fixture(t, { messages: rows(100), initialFrom: 160 })
  const uid = f.snapshot().floors.at(-1).messageUid
  assert.equal(f.snapshot().floors[0].story, 81)
  assert.equal(f.snapshot().hasMore, true)
  await f.service.loadOlder('s1')
  assert.equal(f.snapshot().floors[0].story, 21)
  assert.equal(f.snapshot().floors.at(-1).messageUid, uid)
  f.chats.set('s2', { messages: rows(2), revision: 3, from: 0 })
  f.views.set('s2', { mode: 'story', canRegenerate: true })
  f.windows.s2 = eventWindow()
  await f.open('s2')
  assert.equal(f.snapshot('s2').floors.length, 2)
  assert.equal(f.snapshot('s1').floors[0].story, 21)
  await f.service.loadOlder('s1')
  assert.equal(f.snapshot().floors[0].story, 1)
  assert.equal(f.snapshot().hasMore, false)
})

test('撤回携带 UID，删除所选楼及以后并返回该楼输入；开场拒绝', async t => {
  const f = await fixture(t, { replies: { rollbackStoryFloor: { view: { mode: 'story', rolledBackTo: { turns: [3, 2] }, clearedInput: '尾部输入' } } } })
  const target = f.target(2)
  const result = await f.service.rollbackTo('s1', target)
  assert.deepEqual(callsOf(f, 'rollbackStoryFloor'), [{ ...plain(target), sessionId: 's1' }])
  assert.deepEqual(plain(result.input), { text: '输入2' })
  assert.deepEqual(plain(result.rolledBack), [3, 2])
  assert.equal(result.clearedInput, '尾部输入')
  await assert.rejects(f.service.rollbackTo('s1', f.target(1)), /开场/)
  assert.equal(callsOf(f, 'rollbackTurn').length, 0)
})

test('重生成携带身份与指导，非最新楼和后台忙碌不发写请求', async t => {
  const f = await fixture(t, { replies: { regenBody: { view: { mode: 'story', canRegenerate: true, regenerationWarning: '已保留生成到的部分正文' } } } })
  const target = f.target()
  const result = await f.service.regenerate('s1', target)
  assert.match(result.regenerationWarning, /部分正文/)
  await f.service.regenerateWithGuidance('s1', target, '写得简短')
  assert.equal(f.service.guidance('s1'), '写得简短')
  assert.deepEqual(callsOf(f, 'regenBody').map(args => args.target), [plain(target), plain(target)])
  assert.deepEqual(callsOf(f, 'regenBody').map(args => args.guidance), ['', '写得简短'])
  await assert.rejects(f.service.regenerate('s1', f.target(2)), /最新楼层/)
  f.view({ mode: 'story', canRegenerate: true, activity: { busy: true } })
  await assert.rejects(f.service.regenerate('s1', target), /正在结算/)
  assert.equal(callsOf(f, 'regenBody').length, 2)
})

test('失败重试使用现有 regenBody，服务端错误保留且清空交互面板', async t => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 7 } },
    { type: 'user/message', seq: 2, surfaceOp: 'append', data: { id: 'failed-input', role: 'user', content: [{ type: 'text', text: '失败输入' }], source: { kind: 'user', rpcId: 'r7' } } },
    { type: 'turn/end', seq: 3, data: { turn: 7, reason: { kind: 'error' } } }
  ]
  const f = await fixture(t, { events, replies: { regenBody: { error: '前台正在生成' } } })
  await assert.rejects(f.service.retryFailed('s1'), /前台正在生成/)
  assert.equal(callsOf(f, 'replayTurn').length, 0)
  assert.deepEqual(callsOf(f, 'regenBody'), [{ sessionId: 's1', guidance: '', retryFailedTurn: 7 }])
  assert.equal(f.client.playControlsFeature.storyActions.interactions.regeneration.getSnapshot(), null)
})

test('持久结果列表标记当前项，切换发送 UID 与结果 ID并保留 MVU 重算能力', async t => {
  const messages = rows()
  messages[5].storyResults = [{ id: 'a'.repeat(64), text: '旧正文' }, { id: 'b'.repeat(64), text: '正文3' }]
  messages[5].storyResultId = 'b'.repeat(64)
  const f = await fixture(t, { messages, replies: { switchFloorResult: { switched: true, turn: 3, replySeq: 'a'.repeat(64), mvu: 'stale', view: { mode: 'story' } } } })
  f.view({ mode: 'story', canRegenerate: true, tavernMvuRuntime: { owner: 'official' } })
  assert.deepEqual(plain(f.service.listResults('s1', f.target()).map(row => [row.text, row.current])), [['旧正文', false], ['正文3', true]])
  const result = await f.service.switchResult('s1', f.target(), 'a'.repeat(64))
  assert.equal(result.resettle, true)
  assert.deepEqual(callsOf(f, 'switchFloorResult')[0], { ...plain(f.target()), turn: 3, replySeq: 'a'.repeat(64), sessionId: 's1' })
})

test('正文编辑令牌绑定 UID，输入编辑使用用户消息 UID，后台 revision 变化不误判身份', async t => {
  const f = await fixture(t, { replies: {
    getBodyEdit: args => ({ edit: { messageUid: args.messageUid, role: args.role || 'assistant', token: 'token', parts: [{ kind: 'text', text: '正文' }] } }),
    saveBodyEdit: { view: { mode: 'story', canRegenerate: true } }
  } })
  const target = f.target()
  const edit = await f.service.editReply.get('s1', target)
  assert.equal(edit.token, 'token')
  f.chats.get('s1').revision++
  await f.service.editReply.save('s1', target, { token: edit.token, texts: ['编辑后'] })
  await f.service.editInput('s1', target, '新的输入')
  assert.deepEqual(callsOf(f, 'getBodyEdit').map(args => args.messageUid), ['m3', 'u3'])
  assert.deepEqual(callsOf(f, 'saveBodyEdit').map(args => [args.messageUid, args.texts]), [['m3', ['编辑后']], ['u3', ['新的输入']]])
  f.replies.getBodyEdit = { edit: { messageUid: 'other', token: 'token', parts: [] } }
  await assert.rejects(f.service.editReply.get('s1', target), /最新正文已变化/)
})

test('分叉交给上游侧栏身份流程，运行中拒绝；错误原样返回', async t => {
  const f = await fixture(t), requests = []
  const unbind = f.client.tavernConversationForkRequests.bind(request => { requests.push(request); return { sessionId: 'fork-1' } })
  t.after(unbind)
  assert.deepEqual(plain(await f.service.forkAt('s1', f.target(2))), { sessionId: 'fork-1' })
  assert.deepEqual(plain(requests), [{ sessionId: 's1', ...plain(f.target(2)) }])
  f.windows.s1.append({ type: 'event', event: { type: 'turn/start', seq: 1, data: { turn: 4 } } })
  await assert.rejects(f.service.forkAt('s1', f.target(2)), /正在生成/)
  assert.equal(requests.length, 1)
})

test('变量未重算、结算与回执映射到显示楼号；重算携带身份和指导', async t => {
  const messages = rows()
  messages[5].turn = 90
  const f = await fixture(t, { messages, replies: { retrySettlement: { view: { mode: 'story', canRegenerate: true } } } })
  f.view({ mode: 'story', canRegenerate: true, staleVariables: { turn: 90, replySeq: 'result' }, settleStatus: 'error', settlementTurn: 90, settleError: '结算失败' })
  assert.equal(f.snapshot().staleVariables.turn, 3)
  assert.equal(f.snapshot().staleVariables.target.messageUid, 'm3')
  assert.equal(f.snapshot().settlement.turn, 3)
  await f.service.resettle('s1', f.target(), { guidance: '补充变量' })
  assert.deepEqual(callsOf(f, 'retrySettlement')[0], { ...plain(f.target()), turn: 90, guidance: '补充变量', sessionId: 's1' })
  await assert.rejects(f.service.resettle('s1', f.target(), { guidance: 'x'.repeat(4001) }), /4000/)
})

test('快照按 UID 与正文指纹失效，旧数字 seq 快照不误用', async t => {
  const f = await fixture(t, { replies: { saveFloorSnapshot: { saved: true } } })
  const floor = f.snapshot().floors[2]
  const rendererVersion = f.render.rendererVersion
  assert.ok(Number.isInteger(rendererVersion))
  await f.service.writeFloorSnapshot('s1', floor, { html: '<p>快照</p>', rendererVersion, truncated: true })
  assert.equal(callsOf(f, 'saveFloorSnapshot')[0].reply, floor.reply.seq)
  assert.equal(callsOf(f, 'saveFloorSnapshot')[0].rendererVersion, rendererVersion)
  f.replies.getFloorSnapshots = { snapshots: { 3: { reply: '11', rendererVersion, html: '旧快照' } } }
  assert.equal(await f.service.readFloorSnapshot('s1', floor), null)
  // 来源一致但缺少或不是当前渲染版本的快照同样不读回。
  f.replies.getFloorSnapshots = { snapshots: { 3: { reply: floor.reply.seq, html: '无版本快照' } } }
  assert.equal(await f.service.readFloorSnapshot('s1', floor), null)
  f.replies.getFloorSnapshots = { snapshots: { 3: { reply: floor.reply.seq, rendererVersion: rendererVersion - 1, html: '旧版本快照' } } }
  assert.equal(await f.service.readFloorSnapshot('s1', floor), null)
  f.replies.getFloorSnapshots = { snapshots: { 3: { reply: floor.reply.seq, rendererVersion, html: '新快照' } } }
  assert.equal((await f.service.readFloorSnapshot('s1', floor)).html, '新快照')
  f.chats.get('s1').messages[5].text = '改过的正文'
  f.chats.get('s1').revision++
  f.windows.s1.replace([])
  await delay(150)
  assert.notEqual(f.snapshot().floors[2].reply.seq, floor.reply.seq)
  assert.equal(f.snapshot().floors[2].messageUid, floor.messageUid)
  assert.equal(await f.service.readFloorSnapshot('s1', f.snapshot().floors[2]), null)
})

test('刷新显示合并点击并重新读逻辑历史；存档撤回不被旧原生记录复活', async t => {
  const f = await fixture(t, { replies: { refreshSessionDisplay: { view: { mode: 'story', displayRevision: 2 } } } })
  const chat = f.chats.get('s1')
  chat.messages = chat.messages.slice(0, 4)
  chat.revision++
  const a = f.service.refreshDisplay('s1'), b = f.service.refreshDisplay('s1')
  assert.equal(a, b)
  await a
  assert.equal(callsOf(f, 'refreshSessionDisplay').length, 1)
  assert.equal(f.snapshot().floors.length, 2)
  assert.equal(f.snapshot().displayRevision, 2)
  assert.equal(f.snapshot().floors[1].messageUid, 'm2')
})

test('公开 renderer 按 UID 投影，流式正文不重建静态楼层数组', async t => {
  const f = await fixture(t)
  const render = f.client.createTavernStoryRender({})
  const projected = await render.projectFloor('s1', f.target())
  assert.equal(projected.parts[0].text, '正文3')
  const w = f.windows.s1
  w.append({ type: 'event', event: { type: 'turn/start', seq: 1, data: { turn: 4 } } })
  w.append({ type: 'event', event: { type: 'user/message', seq: 2, surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '下一轮' }] } } })
  await delay(150)
  const floors = f.snapshot().floors
  for (const text of ['雨', '夜']) w.append({ type: 'transient', event: { type: 'assistant/live-chunk', data: { turn: 4, attemptId: 'a1', chunk: { type: 'text-delta', text } } } })
  await delay(150)
  assert.equal(f.snapshot().open.liveText, '雨夜')
  assert.equal(f.snapshot().floors, floors)
})

test('唯一轮号复用配对正文投影，重复轮号保留各自正文', async t => {
  const messages = [
    { role: 'assistant', turn: 1, messageUid: 'a', text: '正文<StatusPlaceHolderImpl/>', displayMode: 'html' },
    { role: 'assistant', turn: 2, messageUid: 'b', text: '重复一' },
    { role: 'assistant', turn: 2, messageUid: 'c', text: '重复二' }
  ]
  const f = await fixture(t, { messages })
  f.views.set('s1', { mode: 'story', replyProjections: [
    { version: 2, turn: 1, mode: 'markdown', text: '正确正文', parts: [{ kind: 'markdown', text: '正确正文' }] },
    { version: 2, turn: 2, mode: 'markdown', text: '不能覆盖重复行' }
  ] })
  // 通过重新订阅触发同一公开历史读取。
  f.chats.get('s1').revision++
  f.windows.s1.replace([])
  await delay(150)
  const projections = f.snapshot().floors.map(floor => floor.projection)
  assert.equal(projections[0].text, '正确正文')
  assert.deepEqual(plain(projections.slice(1).map(row => row.text)), ['重复一', '重复二'])
})

test('生成中的逻辑占位消息不成为已完成楼层，失败撤下后不留空楼', async t => {
  const f = await fixture(t, { messages: [
    { role: 'assistant', greeting: true, turn: 1, text: '开场', messageUid: 'opening' },
    { role: 'user', text: '待完成输入', messageUid: 'input' },
    { role: 'assistant', turn: 2, text: '', messageUid: 'draft', placeholder: true }
  ] })
  assert.equal(f.snapshot().floors.length, 1)
  const chat = f.chats.get('s1')
  chat.messages.pop(); chat.revision++
  f.windows.s1.replace([])
  await delay(150)
  assert.equal(f.snapshot().floors.length, 1)
})

test('输入模板跟随逻辑消息身份，旧文本或旧 swipe 的模板不复用', async t => {
  const messages = rows(3)
  for (const index of [0, 2, 4]) {
    delete messages[index].turn
    messages[index].tavernPluginData = { template_display: { source: messages[index].text, swipe: 0, html: '<b>模板' + index + '</b>' } }
  }
  messages[2].tavernPluginData.template_display.source = '旧输入'
  messages[4].swipeId = 1
  const f = await fixture(t, { messages })
  assert.deepEqual(plain(f.snapshot().floors.map(floor => floor.inputs[0].templateHtml)), ['<b>模板0</b>', null, null])
})

test('中断后遗留的持久输入不归入下一层，导入的多条输入仍保留', async t => {
  const f = await fixture(t, { messages: [
    { role: 'assistant', greeting: true, turn: 1, text: '开场', messageUid: 'opening' },
    { role: 'user', text: '已中断', source: { kind: 'user', rpcId: 'stopped' } },
    { role: 'user', text: '新输入', source: { kind: 'user', rpcId: 'accepted' } },
    { role: 'assistant', turn: 4, text: '新回复', messageUid: 'reply' },
    { role: 'user', text: '导入一' }, { role: 'user', text: '导入二' },
    { role: 'assistant', turn: 5, text: '导入回复', messageUid: 'imported' }
  ] })
  assert.deepEqual(plain(f.snapshot().floors.map(floor => floor.inputs.map(input => input.text))), [[], ['新输入'], ['导入一', '导入二']])
})


test('编辑回执保留上游排队状态，不把未应用的修改当作已保存', async t => {
  const f = await fixture(t, { replies: {
    getBodyEdit: args => ({ edit: { messageUid: args.messageUid, role: args.role || 'assistant', token: 'token', parts: [] } }),
    saveBodyEdit: { view: null, queued: true, queuedCount: 1 }
  } })
  assert.deepEqual(plain(await f.service.editReply.save('s1', f.target(), { token: 'token', texts: ['排队正文'] })), { view: null, queued: true })
  assert.deepEqual(plain(await f.service.editInput('s1', f.target(), '排队输入')), { view: null, queued: true })
})
