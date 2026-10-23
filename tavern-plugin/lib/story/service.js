import { staleVariablesOf } from './state.js'
import { createFloorResultSwitch } from './floor-result-switch.js'
import { createFloorFork } from './floor-fork.js'
import { interruptStoryQueue } from './interrupt-story-queue.js'
import { createInterruptedRoundTombstone } from './interrupted-round-tombstone.js'
import { createStaleVariablesGuard } from './stale-variables-guard.js'

// 故事操作复用同一套存档、历史事务和原生会话，不另建结算或分叉引擎。
export function createStoryService({
  snapshots,
  chats,
  sessions,
  timeline,
  activity,
  project,
  present,
  sessionPatch,
  prepareFork,
  bindFork
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
    }),
    fork: createFloorFork({
      sessions: { get: sessions.get },
      prepare: prepareFork,
      snapshots,
      bind: bindFork
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
    rejectStaleTurn: createStaleVariablesGuard({
      isStale: async (sessionId) => {
        const chat = await latestChat(sessionId)
        return Boolean(
          chat &&
          chat.mvu?.enabled === true &&
          chat.mvu.owner === 'official' &&
          staleVariablesOf(chat)
        )
      },
      agentFor
    }),
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
