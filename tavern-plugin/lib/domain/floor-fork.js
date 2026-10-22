import { foldStoryRounds } from './story-rounds.js'
import { sessionEvents } from './session-events.js'

/**
 * Fork a game at one story floor (story view, fork contract「从楼层创建分支」).
 *
 * The fork point is the reply the floor shows now: its current surface node, after every
 * settled replacement (regeneration, result switch, edit). The rules for the save state and
 * the native cut stay those of the conversation fork (`prepareConversationFork`/`forkChat`);
 * this module enters by story turn and proves the result instead of trusting the rules:
 * the floors folded from the cut prefix must be exactly the source's floors up to this one,
 * reply node for reply node, and the forked save's floor must say what the forked Session shows.
 *
 * The native fork itself is the host's (`ctx.sessions.fork` in the browser), so this runs in
 * two calls around it: `prepare` names the cut, `bind` checks the new Session and binds it.
 */
export function createFloorFork({ sessions, prepare, bind, snapshots, logger = console }) {
  function storyTurn(value) {
    const turn = Number(value)
    if (!Number.isSafeInteger(turn) || turn < 1) throw new Error('分叉楼层无效')
    return turn
  }
  const sameFloors = (actual, expected) => actual.length === expected.length &&
    actual.every((floor, index) => floor.story === expected[index].story && floor.reply.seq === expected[index].reply.seq)

  async function plan(input) {
    const sessionId = String(input?.sessionId ?? '')
    const turn = storyTurn(input?.turn)
    const session = sessions.get(sessionId)
    if (!session) throw new Error('会话尚未就绪，请刷新后重试')
    const events = sessionEvents(session)
    const floors = foldStoryRounds(events).floors
    const index = floors.findIndex(floor => floor.story === turn)
    if (index < 0 || !session.surface?.nodes?.includes(floors[index].reply.seq)) throw new Error('这一层已不在当前上下文中，无法创建分支')
    // Running, regenerating and settling games are refused here (assertConversationForkable).
    const prepared = await prepare(sessionId, turn)
    if (prepared.turn !== turn) throw new Error('分叉楼层与存档不一致，请刷新后重试')
    const expected = floors.slice(0, index + 1)
    if (!sameFloors(foldStoryRounds(events.filter(event => event.seq <= prepared.atSeq)).floors, expected)) {
      throw new Error('分叉边界与当前楼层不一致，无法安全创建分支')
    }
    return { ...prepared, sessionId, replySeq: floors[index].reply.seq, expected }
  }

  /** @returns {Promise<{ turn: number, replySeq: number, atSeq: number, sourceRevision: number }>} */
  async function prepareFork(input = {}) {
    const planned = await plan(input)
    return { turn: planned.turn, replySeq: planned.replySeq, atSeq: planned.atSeq, sourceRevision: planned.source._storageRevision }
  }

  /** @returns {Promise<{ fork: object, turn: number, replySeq: number }>} */
  async function forkFloor(input = {}) {
    const planned = await plan(input)
    if (input.atSeq !== planned.atSeq || input.sourceRevision !== planned.source._storageRevision) throw new Error('源对话已变化，请重新选择分叉楼层')
    const targetId = String(input.targetSessionId ?? '')
    const target = targetId ? sessions.get(targetId) : undefined
    if (!target) throw new Error('分叉目标会话尚未就绪')
    // The host's copy is what the new game will play on: the same floors, and the save agrees with it.
    const targetEvents = sessionEvents(target)
    if (!sameFloors(foldStoryRounds(targetEvents).floors, planned.expected)) throw new Error('分叉出的模型上下文与所选楼层不一致，已拒绝绑定')
    // The floor's prose as the forked save holds it (raw output, projection or edited text,
    // as native repair compares them) must be what the forked model context shows.
    const saved = planned.state.messages.findLast(message => message?.role === 'assistant')
    const texts = new Set([saved?.text, saved?.sourceText, saved?.projectionText].filter(text => typeof text === 'string').map(text => text.trim()))
    if (!texts.has(String(planned.expected.at(-1).reply.text).trim())) throw new Error('分叉出的模型上下文与存档正文不一致，已拒绝绑定')
    const fork = await bind({ sessionId: planned.sessionId, targetSessionId: targetId, turn: planned.turn, sourceRevision: input.sourceRevision, atSeq: input.atSeq })
    // Snapshots are a display cache keyed by reply seq, which the fork keeps: a failure never undoes the fork.
    try { await snapshots.copyChat(planned.source.id, fork.chatId, planned.turn) }
    catch (error) { logger.warn('dsh-tavern: 分叉时复制楼层快照失败:', String(error?.message || error)) }
    return { fork, turn: planned.turn, replySeq: planned.replySeq }
  }

  return Object.freeze({ prepare: prepareFork, fork: forkFloor })
}
