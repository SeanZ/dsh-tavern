// One record per background run, kept per game, so the status panel can show what ran,
// what is queued and what failed. In memory only: durable task truth stays in the story timeline.
const TRANSITIONS = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: []
}
const KEPT_PER_GAME = 30

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

export function createBackgroundRunLedger(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const games = new Map()
  let sequence = 0

  function move(record, status, fields) {
    if (!TRANSITIONS[record.status].includes(status)) return
    Object.assign(record, fields, { status })
  }

  function begin(input) {
    const gameId = str(input.sessionId)
    const record = {
      id: 'run-' + ++sequence,
      task: str(input.task) || 'background',
      plugin: str(input.pluginName),
      lane: input.persistent === true ? 'resident' : 'ephemeral',
      turn: Math.max(0, Number(input.turn) || 0),
      model: str(input.selection?.model),
      status: 'queued',
      queuedAt: now()
    }
    const list = games.get(gameId) || []
    list.push(record)
    // Drop the oldest finished runs; unfinished ones always stay visible.
    while (list.length > KEPT_PER_GAME) {
      const index = list.findIndex(item => !['queued', 'running'].includes(item.status))
      if (index < 0) break
      list.splice(index, 1)
    }
    games.set(gameId, list)
    return {
      start: selection => move(record, 'running', { startedAt: now(), ...(selection?.model ? { model: str(selection.model) } : {}) }),
      finish: () => move(record, 'completed', { endedAt: now() }),
      fail: (error, cancelled) => move(record, cancelled ? 'cancelled' : 'failed', { endedAt: now(), ...(cancelled ? {} : { error: str(error?.message || error).slice(0, 300) }) })
    }
  }

  // Newest first.
  function list(gameId) {
    return (games.get(str(gameId)) || []).slice().reverse().map(record => ({ ...record }))
  }

  function forget(gameId) {
    games.delete(str(gameId))
  }

  return Object.freeze({ begin, list, forget })
}
