import { Worker } from 'node:worker_threads'
import { worldbookClusterInputHash } from './worldbook-skill-clustering.js'

/** Per-game derived, in-memory catalog. Original JSON remains the only authority.
 * update resolves to the newest atomic commit (including superseding updates).
 * Initial build starts immediately; edits are trailing-edge debounced for 750ms.
 * The owner MUST dispose a scope on game switch/deletion, and all on plugin stop.
 */
export function createWorldbookSkillCatalog({ debounceMs = 750, workerFactory = data => new Worker(new URL('./worldbook-skill-cluster-worker.js', import.meta.url), { workerData: data }), compileOptions = {} } = {}) {
  if (!Number.isFinite(debounceMs) || debounceMs < 500 || debounceMs > 1000) throw new Error('Worldbook catalog debounce must be 500–1000ms')
  const scopes = new Map()
  let disposed = false
  const settle = (state, error, result) => {
    for (const waiter of state.waiters.splice(0)) error ? waiter.reject(error) : waiter.resolve(result)
  }
  const cancel = state => {
    clearTimeout(state.timer); state.timer = null
    if (state.worker) { const worker = state.worker; state.worker = null; void worker.terminate() }
  }
  function start(key, state, generation, entries) {
    state.timer = null
    if (disposed || scopes.get(key) !== state || state.generation !== generation) return
    let worker
    try { worker = workerFactory({ entries, options: { preserveMembership: true, ...compileOptions, previousClusters: state.catalog?.clusters || state.seedClusters || [] } }) }
    catch (error) { state.pendingHash = null; settle(state, error); return }
    state.worker = worker
    let completed = false
    const finish = (error, result) => {
      if (completed) return
      completed = true
      if (state.worker === worker) state.worker = null
      void worker.terminate()
      if (disposed || scopes.get(key) !== state || state.generation !== generation) return
      state.pendingHash = null
      if (error) { settle(state, error); return }
      // Replace the entire immutable-by-contract catalog, never expose a partial build.
      state.catalog = result
      settle(state, null, result)
    }
    worker.once('message', message => finish(message.error ? Object.assign(new Error(message.error.message), { stack: message.error.stack }) : null, message.result))
    worker.once('error', error => finish(error))
    worker.once('exit', code => { if (!completed) finish(new Error(`Worldbook clustering worker exited before a result (${code})`)) })
  }
  return {
    update(key, input, { previousClusters = [] } = {}) {
      if (disposed) return Promise.reject(new Error('Worldbook skill catalog disposed'))
      if (typeof key !== 'string' || !key) return Promise.reject(new Error('Worldbook skill scope key is required'))
      let entries
      try { entries = structuredClone(input) } catch (error) { return Promise.reject(error) }
      const inputHash = worldbookClusterInputHash(entries)
      let state = scopes.get(key)
      if (!state) { state = { generation: 0, catalog: null, pendingHash: null, worker: null, timer: null, waiters: [], started: previousClusters.length > 0, seedClusters: structuredClone(previousClusters) }; scopes.set(key, state) }
      if (!state.pendingHash && state.catalog?.inputHash === inputHash) return Promise.resolve(state.catalog)
      const result = new Promise((resolve, reject) => state.waiters.push({ resolve, reject }))
      if (state.pendingHash === inputHash) return result
      state.generation++
      cancel(state)
      if (state.catalog?.inputHash === inputHash) { state.pendingHash = null; settle(state, null, state.catalog); return result }
      state.pendingHash = inputHash
      const generation = state.generation
      if (!state.started) { state.started = true; start(key, state, generation, entries) }
      else state.timer = setTimeout(() => start(key, state, generation, entries), debounceMs)
      return result
    },
    read(key) { return scopes.get(key)?.catalog || null },
    dispose(key) {
      if (key === undefined) disposed = true
      for (const [scope, state] of scopes) if (key === undefined || key === scope) {
        state.generation++; cancel(state); scopes.delete(scope)
        settle(state, new Error('Worldbook skill scope disposed'))
      }
    }
  }
}
