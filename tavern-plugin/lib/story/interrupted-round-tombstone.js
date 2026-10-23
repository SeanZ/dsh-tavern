import { clearFailedTurnSurface } from '../domain/rollback-surface.js'
import { sessionEvents } from '../domain/session-events.js'
import { inputEventForTurn, inputKind, isFailedTurnEnd } from '../domain/session-turn-input.js'
import { SurfaceRecoveryError } from '../domain/surface-recovery.js'

/**
 * Story view mode (fork contract C2): a player's turn that failed or was stopped leaves
 * the model's surface the moment it ends, instead of at the player's next action. One
 * replacement shadows exactly that turn's nodes — its input, the frame context written
 * for it and the partial reply — located by the turn's own seq interval
 * (planFailedTurnSurface), never "everything after the stop", so a message that arrived
 * meanwhile stays. The append-only log keeps all of it; the partial body never reaches
 * the save or a later request. With the setting off nothing is written and the upstream
 * deferred cleanup (the next send, retry or withdraw) applies unchanged.
 *
 * The caller has already decided the game is in story or script mode.
 * @returns {(target: { sessionId: string, turn: number }) => Promise<number>} shadowed node count
 */
export function createInterruptedRoundTombstone({ enabled, sessionFor, latestChat, flush, logger = console }) {
  return async function tombstoneInterruptedRound({ sessionId, turn }) {
    if (await enabled() !== true) return 0
    const session = sessionFor(sessionId)
    if (!session) return 0
    turn = Number(turn)
    const end = sessionEvents(session).findLast(event => event?.type === 'turn/end' && Number(event.data?.turn) === turn)
    if (!end || !isFailedTurnEnd(end.data?.reason?.kind)) return 0
    // Only the player's own turns: a regeneration attempt is undone by its own abort.
    if (inputKind(inputEventForTurn(session, turn)?.data) !== 'player') return 0
    // Stopped after its round was saved: that round is story, not residue.
    const chat = await latestChat(sessionId)
    const regenerated = Object.values(chat?.regeneratedDshTurns || {}).map(Number)
    if ((chat?.messages || []).some(message => message?.role === 'assistant' && Number(message.turn) === turn) || regenerated.includes(turn)) return 0
    let cleared = 0
    try { cleared = clearFailedTurnSurface({ session, turn }) }
    catch (error) {
      if (!(error instanceof SurfaceRecoveryError)) throw error
      // The upstream cleanup at the next send reports and handles the same range.
      logger.warn('dsh-tavern: 中断回合无法立即从模型上下文移除，留待下一次发送清理:', error.message)
      return 0
    }
    if (cleared) await flush(session)
    return cleared
  }
}
