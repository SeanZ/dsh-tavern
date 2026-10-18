// Frames report their DOM/console/network about once a second while a card animates,
// and every saved report rewrites the conversation store. Persist at once what
// diagnosis and the status-panel receipt need (a frame's first capture, changed
// errors, layout or MVU use); coalesce everything else into one trailing write per
// frame every intervalMs.
import { snapshotCollected } from './display-runtime-metadata.js'

export const DISPLAY_CAPTURE_INTERVAL_MS = 15000

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

function signature(runtime) {
  const value = runtime && typeof runtime === 'object' ? runtime : {}
  return JSON.stringify([value.layout || null,
    (Array.isArray(value.errors) ? value.errors : []).map(item => [item && item.kind, item && item.message, item && item.url, item && item.line])])
}

export function createDisplayRuntimeCoalescer({ write, intervalMs = DISPLAY_CAPTURE_INTERVAL_MS, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, limit = 256, logger = console }) {
  const frames = new Map()
  function remember(key, state) {
    frames.delete(key)
    frames.set(key, state)
    while (frames.size > limit) {
      const [oldest, stale] = frames.entries().next().value
      if (stale.timer) clearTimer(stale.timer)
      frames.delete(oldest)
    }
  }
  function flush(key) {
    const frame = frames.get(key)
    if (!frame || !frame.pending) return
    const { sessionId, turn, partIndex, runtime } = frame.pending
    frame.pending = null
    frame.timer = null
    frame.writtenAt = now()
    Promise.resolve().then(() => write(sessionId, turn, partIndex, runtime))
      .catch(error => logger.warn('dsh-tavern: 状态栏诊断延迟保存失败', str(error && error.message || error)))
  }
  async function capture(sessionId, turn, partIndex, runtime) {
    // MVU-use marks are a separate, rare signal the client acts on immediately.
    if (runtime && runtime.mvuViewUsed === true) return await write(sessionId, turn, partIndex, runtime)
    const key = JSON.stringify([str(sessionId), Number(turn) || 0, Number(partIndex) || 0, str(runtime && runtime.panelId)])
    const at = now()
    const frame = frames.get(key)
    const sig = signature(runtime)
    // 宿主显式请求的 DOM 快照同样罕见且由人触发：不等 15 秒窗口，直接落盘，
    // 并丢弃同一 frame 排队中的旧轻量包，免得旧包稍后覆盖这次的快照、日志与 layout。
    if (snapshotCollected(runtime && runtime.domSnapshot)) {
      if (frame && frame.timer) clearTimer(frame.timer)
      remember(key, { signature: sig, writtenAt: at, pending: null, timer: null })
      return await write(sessionId, turn, partIndex, runtime)
    }
    if (!frame || frame.signature !== sig || at - frame.writtenAt >= intervalMs) {
      if (frame && frame.timer) clearTimer(frame.timer)
      remember(key, { signature: sig, writtenAt: at, pending: null, timer: null })
      return await write(sessionId, turn, partIndex, runtime)
    }
    frame.pending = { sessionId, turn, partIndex, runtime }
    if (!frame.timer) frame.timer = setTimer(() => flush(key), Math.max(0, frame.writtenAt + intervalMs - at))
    return { captured: false, deferred: true, turn: Math.max(1, Number(turn) || 0), partIndex: Math.max(0, Math.min(100, Number(partIndex) || 0)) }
  }
  return { capture }
}
