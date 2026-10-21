import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeRepairGame, repairEvidence } from './fixtures/native-repair-game.mjs'
import { applyNativeSurfaceRepair, planNativeSurfaceRepair } from '../tavern-plugin/lib/domain/native-surface-repair.js'
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
})
