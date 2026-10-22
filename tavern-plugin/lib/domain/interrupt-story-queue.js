import { openTurnStep, sessionEvents } from './session-events.js'

// 当前宿主 keepInbox 只保留队列；取消后重新投递队尾同一条消息，唤醒暂停的 FIFO。
// 全程同步，保留消息 ID、附件与 source，不插入空消息、不复制用户输入。
export function interruptStoryQueue(agent, expectedTurn) {
  if (!Number.isSafeInteger(expectedTurn) || expectedTurn < 1) throw new Error('缺少要打断的原生回合')
  if (!agent || agent.status !== 'running' || openTurnStep(sessionEvents(agent.session)).turn !== expectedTurn)
    return { interrupted: false }
  const message = agent.inbox.nextTurn.at(-1)
  if (!message) return { interrupted: false }
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  agent.inbox.remove(message.id)
  agent.followup(message)
  return { interrupted: true }
}
