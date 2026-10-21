import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from './fixtures/dsh-session-host.mjs'
import { hostAssistantRows } from './fixtures/host-assistant-rows.mjs'
import { nativeRepairGame, repairEvidence } from './fixtures/native-repair-game.mjs'
import { projectionFixture } from './fixtures/session-view-projection.mjs'
import {
  applyNativeSurfaceRepair,
  repairNativeSurface,
  recordNativeSurfaceRepair,
} from '../tavern-plugin/lib/domain/native-surface-repair.js'
import { createSessionSurfaceMutator } from '../tavern-plugin/lib/domain/session-surface-mutations.js'
import { planTranscriptRows, planShowsRow, planStoryTurn } from '../tavern-plugin/lib/domain/transcript-row-plan.js'
import { sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'

function visible(session, chat, view = {}) {
  const plan = view.transcriptTurns || planTranscriptRows({ chat, events: sessionEvents(session) })
  return hostAssistantRows(sessionEvents(session))
    .filter((row) => planShowsRow(plan, row))
    .map((row) => {
      const story = planStoryTurn(plan, row.turn)
      return view.replyProjections?.find((item) => item.turn === story)?.text || row.text
    })
}
const expected = ['正文1', '修订2', '修订3']
function revise(chat) {
  for (const message of chat.messages)
    if (message.role === 'assistant' && !message.greeting) message.text = `修订${message.turn}`
}

test('整段修复的开场没有玩家输入时，仍写入宿主可绘制正文', () => {
  const { session, chat } = nativeRepairGame()
  const result = applyNativeSurfaceRepair(
    session,
    chat,
    {
      status: 'full',
      keep: 0,
      rounds: [
        { turn: 1, messageIndex: 0, greeting: true, userText: null, replyText: '恢复的开场' },
        { turn: 2, messageIndex: 2, userText: '行动2', replyText: '恢复的正文' },
      ],
    },
    { repairId: 'opening' },
  )
  assert.equal(result.applied, true)
  const repaired = hostAssistantRows(sessionEvents(session)).filter((row) => row.turn > 3)
  assert.deepEqual(
    repaired.map((row) => row.text),
    ['恢复的开场', '恢复的正文'],
  )
})

test('每个修复轮保留独立宿主正文，写入磁盘并冷读后仍可显示', async (t) => {
  const { session, chat } = nativeRepairGame()
  revise(chat)
  const result = repairNativeSurface(session, chat, { repairId: 'separate-rounds' })
  recordNativeSurfaceRepair(chat, chat, result.anchors)
  assert.deepEqual(visible(session, chat), expected)
  const replies = sessionEvents(session).filter((event) => event.data?.message?.source?.model === 'native-repair')
  assert.equal(new Set(replies.map((event) => `${event.data.turn}:${event.data.step}`)).size, 2)
  const directory = await mkdtemp(join(tmpdir(), 'tavern-repair-display-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'session.jsonl')
  await writeFile(
    file,
    sessionEvents(session)
      .map((event) => JSON.stringify(event))
      .join('\n'),
  )
  const rows = (await readFile(file, 'utf8')).split('\n').map((line) => JSON.parse(line))
  const restored = Session.fromRestore(session.id, rows, session.header, 0, 'detached')
  assert.deepEqual(visible(restored, chat), expected)
})

// 按旧格式构造一个编辑步骤的多轮输出；新代码不能靠重写这些存量日志修复显示。
function appendLegacyRepair(session) {
  const mutator = createSessionSurfaceMutator(session)
  mutator.editStep(() => {
    for (const turn of [2, 3])
      mutator.append(
        'assistant/message',
        {
          turn,
          step: 1,
          message: {
            id: `legacy-repair-${turn}`,
            role: 'assistant',
            content: [{ type: 'text', text: `修订${turn}` }],
            source: { kind: 'model', provider: 'dsh-tavern', model: 'native-repair', tavernStoryTurn: turn },
          },
        },
        { surfaceOp: 'append', sourceEventSeqs: [] },
      )
  })
}

for (const rich of [false, true])
  test(`旧版多轮修复的${rich ? '富文本' : '普通'}正文在全量、缓存和增量视图一致`, async () => {
    const { session, chat } = nativeRepairGame()
    const extensions = rich
      ? {
          regexScripts: [
            {
              id: 'rich',
              findRegex: '/修订(\\d)/g',
              replaceString: '<div>修订$1</div>',
              placement: [2],
              markdownOnly: true,
            },
          ],
          helperScripts: [],
        }
      : undefined
    const fixture = projectionFixture({
      sessionDebugEvidence: () => repairEvidence(session),
      ...(extensions ? { readCardExtensions: async () => extensions } : {}),
    })
    Object.assign(chat, { cardPath: fixture.chat.cardPath, cardName: fixture.chat.cardName, mvu: fixture.chat.mvu })
    revise(chat)
    const before = await fixture.projection.project.full(chat)
    appendLegacyRepair(session)
    const bytes = JSON.stringify(sessionEvents(session))
    const full = await fixture.projection.project.full(chat)
    const cached = await fixture.projection.project.cached(chat, before, { busy: false, phase: 'idle' })
    const dirty = await fixture.projection.project.dirty(chat, before, [2, 4], { busy: false, phase: 'idle' })
    const wanted = rich ? ['正文1', '<div>修订2</div>', '<div>修订3</div>'] : expected
    for (const view of [full, cached, dirty]) assert.deepEqual(visible(session, chat, view), wanted)
    assert.equal(JSON.stringify(sessionEvents(session)), bytes, '展示修复不改写原生历史')
  })
