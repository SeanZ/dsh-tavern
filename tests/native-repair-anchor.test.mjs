import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeRepairGame, repairEvidence } from './fixtures/native-repair-game.mjs'
import { applyNativeSurfaceRepair, planNativeSurfaceRepair, recordNativeSurfaceRepair, repairNativeSurface } from '../tavern-plugin/lib/domain/native-surface-repair.js'
import { createRoundAnchorResolver } from '../tavern-plugin/lib/domain/round-anchor.js'
import { sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import { Session } from './fixtures/dsh-session-host.mjs'

for (const sameText of [false, true]) {
  test(`修复后恢复旧快照锚点仍按故事轮定位，正文相同=${sameText}`, () => {
    const { session, chat } = nativeRepairGame()
    if (sameText) for (const row of chat.messages) if (row.role === 'assistant') row.text = '重复正文'
    const original = structuredClone(chat)
    const plan = {
      status: 'full',
      keep: 0,
      rounds: chat.messages.flatMap((row, messageIndex) =>
        row.role === 'assistant'
          ? [
              {
                messageIndex,
                turn: row.turn,
                greeting: row.greeting,
                userText: row.greeting ? null : `行动${row.turn}`,
                replyText: row.text,
              },
            ]
          : [],
      ),
    }
    applyNativeSurfaceRepair(session, chat, plan, { repairId: 'old-snapshot' })
    // JSONL 冷读后的存档仍携带修复前的锚点，不能再追加一轮修复。
    const restored = Session.fromRestore(
      session.id,
      sessionEvents(session).map((event) => JSON.parse(JSON.stringify(event))),
    )
    const evidence = repairEvidence(restored)
    const resolve = createRoundAnchorResolver(evidence)
    for (const row of original.messages.filter((row) => row.nativeAnchor)) {
      const found = resolve(row.nativeAnchor)
      const reply = evidence.events.find((event) => event.seq === found?.reply)
      const input = evidence.events.find((event) => event.seq === found?.input)
      assert.equal(reply?.data?.message?.source?.tavernStoryTurn, row.turn)
      assert.equal(input?.data?.id, reply.data.message.id.replace(/:reply$/, ':input'))
    }
    const count = evidence.events.length
    for (let retry = 0; retry < 3; retry++) {
      const next = planNativeSurfaceRepair({ chat: original, ...repairEvidence(restored) })
      assert.equal(next.status, 'intact')
      assert.equal(applyNativeSurfaceRepair(restored, original, next, { repairId: `retry-${retry}` }).applied, false)
    }
    assert.equal(sessionEvents(restored).length, count)
  })
}

test('修复后的正文和输入继续编辑，旧锚点仍定位当前节点', async () => {
  const { synchronizeBodyEdits } = await import('../tavern-plugin/lib/domain/body-editor.js')
  const { session, chat } = nativeRepairGame()
  const original = structuredClone(chat.messages.at(-1).nativeAnchor)
  chat.messages.at(-1).text = '修复后的正文'
  const plan = planNativeSurfaceRepair({ chat, ...repairEvidence(session) })
  const repaired = applyNativeSurfaceRepair(session, chat, plan, { repairId: 'then-edit' })
  const anchor = repaired.anchors.at(-1).anchor
  chat.messages.at(-1).text = '再次编辑正文'
  chat.messages.at(-1).bodyEdit = { id: 'edited-reply', seq: anchor.reply, turn: 3, formatVersion: 4 }
  const user = chat.messages.at(-2)
  user.text = '再次编辑输入'
  user.bodyEdit = { id: 'edited-input', seq: anchor.input, turn: 3, role: 'user', formatVersion: 4 }
  await synchronizeBodyEdits(session, chat, async () => {})
  const evidence = repairEvidence(session)
  const found = createRoundAnchorResolver(evidence)(original)
  assert.equal(evidence.events.find((event) => event.seq === found.reply).data.message.id, 'edited-reply')
  assert.equal(evidence.events.find((event) => event.seq === found.input).data.id, 'edited-input')
  assert.equal(planNativeSurfaceRepair({ chat, ...evidence }).status, 'intact')
})

test('同一故事有多个有效修复正文时不猜测归属', () => {
  const source = { kind: 'model', model: 'native-repair', tavernStoryTurn: 2 }
  const events = [1, 2].map((seq) => ({
    seq,
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      message: { id: `tavern-native-repair:a:${seq}:reply`, source, content: [{ type: 'text', text: '一样的正文' }] },
    },
  }))
  assert.deepEqual(createRoundAnchorResolver({ events, nodes: [1, 2] })({ turn: 2, input: 7, reply: 8 }), {
    input: null,
    reply: null,
    ambiguous: true,
  })
  // 修复后记下的新锚点直接指向其中一条修复正文：同一故事身份仍重复，照样报歧义。
  assert.deepEqual(createRoundAnchorResolver({ events, nodes: [1, 2] })({ turn: 9, input: 0, reply: 1 }), {
    input: null,
    reply: null,
    ambiguous: true,
  })
})

// 故事分叉在空白 Session 上整段建立原生上下文：多层正文写在同一个编辑轮，锚点保存的是该编辑轮的
// 原生轮次（都是 1），各层的故事身份只在回复事件的 source.tavernStoryTurn 上。
function seededFork() {
  const { chat } = nativeRepairGame()
  for (const row of chat.messages) delete row.nativeAnchor
  chat.id = 'fork-save'
  const session = Session.create('fork-session')
  const repaired = repairNativeSurface(session, chat, { repairId: 'seed' })
  assert.equal(repaired.plan.status, 'full')
  assert.equal(repaired.applied, true)
  assert.equal(recordNativeSurfaceRepair(chat, structuredClone(chat), repaired.anchors), true)
  return { session, chat }
}

test('空白 Session 整段修复后，各层新锚点按自己的故事身份定位，不被同一编辑轮的开场顶替', () => {
  const { session, chat } = seededFork()
  const anchored = chat.messages.filter((row) => row.nativeAnchor)
  assert.deepEqual(anchored.map((row) => row.turn), [2, 3])
  assert.deepEqual(anchored.map((row) => row.nativeAnchor.turn), [1, 1], '同一编辑轮写入，原生轮次相同')
  const evidence = repairEvidence(session)
  const resolve = createRoundAnchorResolver(evidence)
  for (const row of anchored) {
    const found = resolve(row.nativeAnchor)
    assert.equal(found.ambiguous, undefined, `第 ${row.turn} 层身份唯一`)
    const reply = evidence.events.find((event) => event.seq === found.reply)
    const input = evidence.events.find((event) => event.seq === found.input)
    assert.equal(reply?.data?.message?.source?.tavernStoryTurn, row.turn)
    assert.equal(reply.data.message.content[0].text, row.text)
    assert.equal(input?.data?.id, reply.data.message.id.replace(/:reply$/, ':input'))
  }
})

test('空白 Session 整段修复后立即核对为一致，再次修复无动作；冷读后不变', () => {
  const { session, chat } = seededFork()
  const count = sessionEvents(session).length
  for (let retry = 0; retry < 3; retry++) {
    const next = planNativeSurfaceRepair({ chat, ...repairEvidence(session) })
    assert.equal(next.status, 'intact', JSON.stringify(next))
    assert.equal(repairNativeSurface(session, chat, { repairId: `retry-${retry}` }).applied, false)
  }
  assert.equal(sessionEvents(session).length, count)
  const restored = Session.fromRestore(session.id, sessionEvents(session).map((event) => JSON.parse(JSON.stringify(event))))
  assert.equal(planNativeSurfaceRepair({ chat, ...repairEvidence(restored) }).status, 'intact')
  assert.equal(repairNativeSurface(restored, chat, { repairId: 'cold' }).applied, false)
})
