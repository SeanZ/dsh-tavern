// The task table, after GitHub Actions' workflow: every background task the story starts
// is one declaration — which moments start it (`on`), when it runs at all (`if`), what
// it does (`run`) and which moments stop it (`cancelOn`, `cancel`). The scheduler follows
// the story events for it, so the declaration is the only place a task's trigger is
// written, and the 后台任务 page reads it from here.
// More of a task (needs, concurrency, outputs) moves into its declaration step by step.

function list(value) {
  return (Array.isArray(value) ? value : [value]).filter(item => item !== undefined && item !== null).map(String).filter(Boolean)
}

// The game a moment happened in: `sessionId`, or a settled turn's save header. A moment
// with no game (a settlement whose save could not be read) starts no task.
function gameOf(payload) {
  return String(payload?.sessionId || payload?.latest?.sessionId || '')
}

export function createWorkflow({ events }) {
  if (!events || typeof events.on !== 'function') throw new Error('任务表缺少剧情事件')
  const jobs = new Map()

  /** Declare a task; returns the function that removes it. */
  function job(declaration) {
    const id = String(declaration?.id || '')
    const name = String(declaration?.name || id)
    const on = list(declaration?.on)
    const cancelOn = list(declaration?.cancelOn)
    const { if: when, run, cancel } = declaration || {}
    if (!id) throw new Error('任务缺少 id')
    if (jobs.has(id)) throw new Error('任务 ' + id + ' 已声明')
    if (on.length === 0) throw new Error('任务 ' + name + ' 缺少触发事件')
    if (typeof run !== 'function') throw new Error('任务 ' + name + ' 缺少 run')
    if (when !== undefined && typeof when !== 'function') throw new Error('任务 ' + name + ' 的 if 必须是函数')
    if (cancelOn.length > 0 && typeof cancel !== 'function') throw new Error('任务 ' + name + ' 有 cancelOn 但缺少 cancel')
    const entry = Object.freeze({ id, name, on: Object.freeze(on), cancelOn: Object.freeze(cancelOn) })
    // A failing `if`, run or cancel is the events' to report, under the task's name.
    const follow = (event, label, work) => events.on(event, label, payload => {
      const gameId = gameOf(payload)
      if (!gameId) return
      return work({ ...payload, gameId }, event)
    })
    const stops = [
      ...on.map(event => follow(event, name, (payload, event) => {
        if (when && !when(payload, event)) return
        return run(payload, event)
      })),
      ...cancelOn.map(event => follow(event, '取消' + name, cancel))
    ]
    jobs.set(id, entry)
    return () => {
      if (jobs.get(id) !== entry) return
      jobs.delete(id)
      for (const stop of stops) stop()
    }
  }

  /** Declared tasks, in declaration order. */
  function table() {
    return [...jobs.values()]
  }

  return Object.freeze({ job, table })
}
