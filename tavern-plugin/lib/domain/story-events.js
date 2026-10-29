// The moments in a story that start or stop background work. Where the story reaches
// one, it only announces it; what follows is registered here by name, so one table
// (table(), shown on the 后台任务 page) lists every task each moment starts.
export const STORY_EVENTS = Object.freeze({
  // { sessionId }: a reply or a regenerated reply was saved.
  'reply-committed': '正文写完',
  // { chatId, latest }: a turn's background settlement finished; `latest` is the
  // save's header after it, or null when it could not be read.
  'turn-settled': '本轮结算完',
  // { sessionId, turn }: a reply failed or was stopped, and its turn is thrown away.
  'turn-discarded': '回合作废'
})

export function createStoryEvents({ logger = console } = {}) {
  const followers = new Map(Object.keys(STORY_EVENTS).map(event => [event, []]))

  function on(event, label, listener) {
    const list = followers.get(event)
    if (!list) throw new Error('未知的剧情事件：' + event)
    const follower = { label: String(label), listener }
    list.push(follower)
    return () => { const index = list.indexOf(follower); if (index >= 0) list.splice(index, 1) }
  }

  // Fire and forget: one failing follower never keeps the others from running.
  function emit(event, payload) {
    const list = followers.get(event)
    if (!list) throw new Error('未知的剧情事件：' + event)
    for (const { label, listener } of [...list]) {
      const warn = error => logger.warn('dsh-tavern: ' + STORY_EVENTS[event] + '后「' + label + '」失败:', error?.message || error)
      try {
        const pending = listener(payload)
        if (pending && typeof pending.catch === 'function') pending.catch(warn)
      } catch (error) { warn(error) }
    }
  }

  function table() {
    return Object.entries(STORY_EVENTS).map(([event, name]) => ({ event, name, followers: followers.get(event).map(item => item.label) }))
  }

  return Object.freeze({ on, emit, table })
}
