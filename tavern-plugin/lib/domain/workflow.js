// The task table, after GitHub Actions' workflow: every background task the story starts
// is one declaration — which moments start it (`on`), when it runs at all (`if`) and what
// it does (`run`). The scheduler follows the story events for it, so the declaration is
// the only place a task's trigger is written, and the 后台任务 page reads it from here.
// More of a task (needs, concurrency, outputs) moves into its declaration step by step.

function list(value) {
  return (Array.isArray(value) ? value : [value]).filter(item => item !== undefined && item !== null).map(String).filter(Boolean)
}

export function createWorkflow({ events }) {
  if (!events || typeof events.on !== 'function') throw new Error('任务表缺少剧情事件')
  const jobs = new Map()

  /** Declare a task; returns the function that removes it. */
  function job(declaration) {
    const id = String(declaration?.id || '')
    const name = String(declaration?.name || id)
    const on = list(declaration?.on)
    const when = declaration?.if
    const run = declaration?.run
    if (!id) throw new Error('任务缺少 id')
    if (jobs.has(id)) throw new Error('任务 ' + id + ' 已声明')
    if (on.length === 0) throw new Error('任务 ' + name + ' 缺少触发事件')
    if (typeof run !== 'function') throw new Error('任务 ' + name + ' 缺少 run')
    if (when !== undefined && typeof when !== 'function') throw new Error('任务 ' + name + ' 的 if 必须是函数')
    const entry = Object.freeze({ id, name, on: Object.freeze(on) })
    // A failing `if` or run is the events' to report, under the task's name.
    const stops = on.map(event => events.on(event, name, payload => {
      if (when && !when(payload, event)) return
      return run(payload, event)
    }))
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
