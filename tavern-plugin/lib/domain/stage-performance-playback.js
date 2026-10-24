// A page visit owns its timers and animations, never persistent presentation state.
function createStagePerformancePlayback({ play, schedule = setTimeout, cancel = clearTimeout }) {
  let visit = null, blocked = false
  const played = new Set(), pending = new Map(), animations = new Set()
  function stop() {
    for (const timer of pending.values()) cancel(timer)
    pending.clear()
    for (const animation of animations) animation.cancel()
    animations.clear()
  }
  function update({ id, at, mode, events }) {
    if (id !== visit) { stop(); played.clear(); visit = id; blocked = false }
    if (!['page', 'live'].includes(mode)) { blocked = true; stop(); return }
    if (blocked) return
    events.forEach((event, ordinal) => {
      if (event.at !== at || played.has(ordinal) || pending.has(ordinal)) return
      pending.set(ordinal, schedule(() => {
        if (visit !== id || blocked) return
        pending.delete(ordinal)
        played.add(ordinal)
        const animation = play(event, id + ':' + ordinal)
        if (animation) {
          animations.add(animation)
          animation.finished.then(() => animations.delete(animation), () => animations.delete(animation))
        }
      }, mode === 'page' ? 1000 : 0))
    })
  }
  return { update, dispose() { stop(); visit = null; played.clear() } }
}

export { createStagePerformancePlayback }
