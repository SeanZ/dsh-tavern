import { staleVariablesOf } from './state.js'
import { createFloorResultSwitch } from './floor-result-switch.js'
import { interruptStoryQueue } from './interrupt-story-queue.js'
import { createInterruptedRoundTombstone } from './interrupted-round-tombstone.js'
import { sessionEvents } from '../domain/session-events.js'
import { compactedHistoryWarning } from '../domain/rollback-compaction.js'
import { createStaleVariablesGuard, dropQueuedPlayerInputs } from './stale-variables-guard.js'

// 故事操作复用同一套存档、历史事务和原生会话，不另建结算引擎；从楼层创建分支走通用对话分叉。
export function createStoryService({
  snapshots,
  chats,
  sessions,
  timeline,
  activity,
  project,
  present,
  sessionPatch
}) {
  return Object.freeze({
    snapshots,
    resultSwitch: createFloorResultSwitch({
      chats,
      sessions: { get: sessions.agent, flush: sessions.flush },
      timeline,
      activity,
      project,
      present,
      sessionPatch
    })
  })
}

// 生命周期守卫读取最新持久状态；界面禁用按钮不能代替服务端检查。
export function createStoryLifecycle({
  settings,
  sessionFor,
  agentFor,
  latestChat,
  flush,
  modeFor
}) {
  return Object.freeze({
    tombstoneInterruptedRound: createInterruptedRoundTombstone({
      enabled: async () => (await settings()).storyViewMode,
      sessionFor,
      latestChat,
      flush
    }),
    async rejectStaleTurn(input) {
      if (!input) return
      const chat = await latestChat(input.sessionId)
      const warning = chat?.suppressedDshTurns?.length
        ? compactedHistoryWarning(sessionEvents(sessionFor(input.sessionId)), chat.suppressedDshTurns) : ''
      if (warning) {
        dropQueuedPlayerInputs(agentFor(input.sessionId))
        throw new Error(warning)
      }
      await createStaleVariablesGuard({
        isStale: async () => Boolean(chat && chat.mvu?.enabled === true && chat.mvu.owner === 'official' && staleVariablesOf(chat)),
        agentFor
      })(input)
    },
    async interruptQueued(input = {}) {
      const mode = await modeFor(input.sessionId)
      if (
        !(await settings()).storyViewMode ||
        !['story', 'script'].includes(mode)
      )
        return { interrupted: false }
      return interruptStoryQueue(agentFor(input.sessionId), input.turn)
    }
  })
}
