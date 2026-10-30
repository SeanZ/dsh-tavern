// 逐字显示: the glyph steps and pauses (modules/stage-typewriter.js) and the typewriter (features/stage-typewriter.js), on a
// one-component hook runner with a fake clock: no browser.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const client = name => readFileSync(new URL('../tavern-plugin/src/client/' + name, import.meta.url), 'utf8')
const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat().filter(child => child !== null && child !== undefined) })
const text = node => typeof node === 'string' ? node : node && typeof node === 'object' ? node.children.map(text).join('') : ''

// One component, re-rendered after every state change; effects run after a render when their deps changed.
function hookRunner() {
  let slots = [], at = 0, effects = [], dirty = false
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]))
  const React = {
    createElement: h, Fragment: 'Fragment',
    useState(initial) {
      const i = at++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true } }]
    },
    useRef(initial) { const i = at++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i] },
    useMemo(fn, deps) { const i = at++; if (!(i in slots) || changed(slots[i].deps, deps)) slots[i] = { value: fn(), deps }; return slots[i].value },
    useEffect(fn, deps) { const i = at++; const old = slots[i]; if (!old || changed(old.deps, deps)) { effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: fn() } }) } }
  }
  return {
    React,
    render(component, props) {
      let out
      do { dirty = false; at = 0; effects = []; out = component(props); effects.forEach(run => run()) } while (dirty)
      return out
    },
    unmount() { slots.forEach(slot => slot?.cleanup?.()) }
  }
}
function clock() {
  let now = 0, id = 0
  const timers = new Map()
  return {
    setTimeout(fn, ms) { timers.set(++id, { fn, at: now + ms }); return id },
    clearTimeout(timer) { timers.delete(timer) },
    // Runs the next due timer; returns its delay from the previous time.
    next() {
      const [key, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0] || []
      if (!timer) return null
      timers.delete(key); const step = timer.at - now; now = timer.at; timer.fn(); return step
    },
    get pending() { return timers.size }
  }
}
// Display frames by hand: frame(ms) moves the frame time on and runs the callbacks waiting for it with that time.
function frames() {
  let now = 0, id = 0, waiting = new Map()
  return {
    requestAnimationFrame(fn) { waiting.set(++id, fn); return id },
    cancelAnimationFrame(frame) { waiting.delete(frame) },
    frame(ms) { now += ms; const run = [...waiting.values()]; waiting = new Map(); run.forEach(fn => fn(now)) }
  }
}
function load() {
  const runner = hookRunner(), time = clock(), display = frames()
  const sandbox = { React: runner.React, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout, Intl,
    requestAnimationFrame: display.requestAnimationFrame, cancelAnimationFrame: display.cancelAnimationFrame }
  const api = vm.runInNewContext([client('modules/stage-runtime.js'), client('modules/stage-typewriter.js'), client('features/stage-typewriter.js'),
    '({ stageGlyphs, stageGlyphPause, stageGlyphDelay, TavernStageTypewriter, STAGE_READING_DEFAULTS, STAGE_SKIN_TEXT_FPS, stageSkinReveal, stageSkinRevealCount, stageSkinGlyphJitter })'].join('\n;'), sandbox)
  return { ...api, runner, time, display }
}

test('a glyph is a grapheme; sentence ends, commas and dashes pause, a closing quote carries its sentence end', () => {
  const { stageGlyphs, stageGlyphPause, stageGlyphDelay } = load()
  assert.deepEqual(Array.from(stageGlyphs('e\u0301👍🏽啊')), ['e\u0301', '👍🏽', '啊'], 'a letter with its mark and an emoji with its tone are one step each')
  const line = Array.from(stageGlyphs('她说：“走吧。”然后，……他—'))
  const pause = glyph => stageGlyphPause(line, line.indexOf(glyph))
  assert.equal(pause('说'), 0, 'inside a run of words: no pause, the colon comes next')
  assert.equal(pause('：'), 2)
  assert.equal(stageGlyphPause(line, line.indexOf('。')), 0, 'the sentence end waits behind its closing quote')
  assert.equal(stageGlyphPause(line, line.indexOf('”')), 5, 'the closing quote carries the sentence end')
  assert.equal(stageGlyphPause(line, line.indexOf('，')), 0, 'a run of punctuation pauses once, at its end')
  assert.equal(stageGlyphPause(line, line.lastIndexOf('…')), 5)
  assert.equal(stageGlyphPause(line, line.length - 1), 0, 'nothing waits after the last glyph')
  const latin = Array.from(stageGlyphs('Mr.Smith. Go'))
  assert.deepEqual([stageGlyphPause(latin, 2), stageGlyphPause(latin, 8)], [0, 5], 'a Latin full stop pauses only before a space')
  assert.deepEqual([stageGlyphDelay(line, -1, 20), stageGlyphDelay(line, line.indexOf('：'), 20)], [20, 60])
})

test('the line types glyph by glyph at the reader\'s speed and reports once it is typed', () => {
  const page = load(), { runner, time } = page
  let done = 0
  const props = { text: '好的。走吧', speed: 30, onDone: () => done++ }
  let out = runner.render(page.TavernStageTypewriter, props)
  assert.equal(text(out), '好的。走吧', 'the whole line is laid out from the start')
  assert.equal(out.children.at(-1).props.className, 'dsh-tavern-stage-type-rest')
  assert.equal(out.props['data-typed'], undefined)
  const steps = []
  for (let i = 0; i < 5; i++) { steps.push(time.next()); out = runner.render(page.TavernStageTypewriter, props) }
  assert.deepEqual(steps, [30, 30, 30, 180, 30], 'one step per glyph; the sentence end waits five more')
  assert.equal(out.props['data-typed'], '')
  assert.equal(done, 1)
  assert.ok(out.children.every(child => child.props.className !== 'dsh-tavern-stage-type-rest'), 'nothing is left hidden')
  assert.deepEqual(out.children.map(child => child.props.className), Array(5).fill('dsh-tavern-stage-glyph'), 'the glyphs still fading in are their own elements')
  time.next(); out = runner.render(page.TavernStageTypewriter, props)
  assert.deepEqual(out.children.map(child => [child.props.className, text(child)]), [['dsh-tavern-stage-type-shown', '好的。走吧']], 'once the last glyphs faded in the line is one plain run')
  runner.unmount()
})

test('a skin\'s stepped reveal runs on one 12/s clock on twos and keeps the reader\'s speed as its budget', () => {
  const { STAGE_SKIN_TEXT_FPS, stageSkinReveal, stageSkinRevealCount } = load()
  const pop = { textFx: { reveal: 'pop', stepFps: 8, charsPerStep: 2 } }
  assert.equal(STAGE_SKIN_TEXT_FPS, 12)
  for (const stepFps of [6, 8, 12, 14]) assert.equal(stageSkinReveal({ textFx: { ...pop.textFx, stepFps } }, 28).stepMs, 1000 / 12, 'authored stepFps ' + stepFps + ' renders on twos')
  assert.deepEqual([6, 8, 12, 14].map(stepFps => stageSkinReveal({ textFx: { ...pop.textFx, stepFps } }, 28).hold), [2, 2, 1, 1], 'stepFps sets how many steps a pose holds')
  // A page takes the reading speed's time; a stutter hesitates on the way but never takes over 1.2x of it.
  for (const kind of ['pop', 'stutter']) for (const speed of [14, 28, 45, 80]) {
    const reveal = stageSkinReveal({ textFx: { ...pop.textFx, reveal: kind } }, speed)
    let shown = 0, steps = 0
    while (shown < 120) { shown += stageSkinRevealCount(reveal, shown, ++steps); assert.ok(steps < 2000) }
    const ms = steps * reveal.stepMs, budget = 120 * speed
    assert.ok((kind === 'stutter' || ms >= budget - reveal.stepMs) && ms <= budget * (kind === 'stutter' ? 1.2 : 1) + 2 * reveal.stepMs, kind + ' at ' + speed + ' ms: ' + ms + ' ms for a ' + budget + ' ms page')
  }
  // A slow reader gets held steps in the authored pairs, not a slower clock.
  const slow = stageSkinReveal(pop, 80), counts = []
  for (let step = 1; step <= 12; step++) counts.push(stageSkinRevealCount(slow, counts.reduce((a, b) => a + b, 0), step))
  assert.ok(counts.every(n => n === 0 || n >= 2) && counts.includes(0), JSON.stringify(counts))
  // A photosensitive skin types plainly; `type` keeps one glyph a step, a skin's cps slowing it to at most 1.2x.
  assert.equal(stageSkinReveal({ ...pop, photosensitive: true }, 28).kind, 'type')
  assert.deepEqual([10, 40, 80].map(cps => stageSkinReveal({ textFx: { reveal: 'type', cps } }, 28).stepMs), [33.6, 28, 28])
  assert.equal(stageSkinReveal({ textFx: { reveal: 'type' } }, 28).stepMs, 28)
})

test('a stepped glyph enters on its step, holds each pose whole steps, then joins the shown text; the line is done once it landed', () => {
  const page = load(), { runner, display } = page
  let done = 0
  const reveal = page.stageSkinReveal({ textFx: { reveal: 'pop', emphasis: 'jitter', jitter: 1 } }, 42)
  const props = { text: '好的。走吧', speed: 42, reveal, onDone: () => done++ }
  let out = runner.render(page.TavernStageTypewriter, props)
  assert.equal(text(out), '好的。走吧', 'the whole line is laid out from the start')
  assert.deepEqual([out.props['data-skin-reveal'], out.props['data-skin-emphasis'], out.props['data-skin-poses']], ['pop', 'jitter', undefined])
  const log = []
  for (let f = 0; f < 60 && !done; f++) {
    display.frame(1000 / 60); out = runner.render(page.TavernStageTypewriter, props)
    const paints = out.children.filter(child => child.props.className === 'dsh-tavern-stage-glyph').map(child => child.children[1])
    log.push({ f, shown: text(out.children.find(child => child.props.className === 'dsh-tavern-stage-type-shown') || ''), hops: paints.map(p => p.props['data-hop']).join(''),
      visible: out.children.filter(child => child.props.className !== 'dsh-tavern-stage-type-rest').map(text).join('').length, typed: out.props['data-typed'] === '' })
  }
  const changes = log.filter((entry, i) => i === 0 || entry.visible !== log[i - 1].visible || entry.hops !== log[i - 1].hops).map(entry => entry.f)
  assert.ok(changes.slice(1).every((f, i) => (f - changes[i]) % 5 === 0), 'every change lands on the 5-frame grid at 60 Hz: ' + changes)
  assert.ok(log.some(entry => entry.hops.includes('0')) && log.some(entry => entry.hops.includes('1')), 'a glyph shows its entry and its landing pose')
  assert.ok(log.every(entry => entry.visible === 0 || entry.shown.length + entry.hops.length === entry.visible), 'a glyph is posed or plain, never both')
  assert.equal(done, 1, 'done once the last glyphs landed')
  assert.equal(log.at(-1).shown, '好的。走吧', 'the landed line is one plain run')
  const visibleAt = log.findIndex(entry => entry.visible === 5)
  assert.ok(visibleAt >= 0 && visibleAt < log.length - 1, 'the line reports done only after its last glyph landed')
  assert.deepEqual([log[visibleAt].typed, log.at(-1).typed], [false, true], 'data-typed waits for the landing too')
  runner.unmount()
  // The paint copy carries the glyph, its seeded jitter and hides from screen readers.
  const again = load(), mid = { ...props, onDone: () => {} }
  assert.equal(again.runner.render(again.TavernStageTypewriter, mid).children.length, 1, 'nothing shows before the first step')
  for (let f = 0; f < 6; f++) again.display.frame(1000 / 60)
  const first = again.runner.render(again.TavernStageTypewriter, mid).children[0].children[1]
  assert.deepEqual([first.props['data-glyph'], first.props['aria-hidden'], first.props['data-hop']], ['好', true, 0])
  assert.deepEqual({ ...first.props.style }, { '--gj-x': again.stageSkinGlyphJitter(0, 1)[0] + 'em', '--gj-y': again.stageSkinGlyphJitter(0, 1)[1] + 'em' })
  // A click finishes it: plain text at once, no posed copies.
  const finished = again.runner.render(again.TavernStageTypewriter, { ...mid, instant: true })
  assert.deepEqual([finished.props['data-skin-reveal'], finished.children.length, text(finished.children[0])], [undefined, 1, '好的。走吧'])
  again.runner.unmount()
})
