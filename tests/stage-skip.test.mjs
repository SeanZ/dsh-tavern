// 跳过 (cast-presentation.md 28/N): a fast-forward through the round's cards, not a jump to its last page. The control latches
// it, a held Ctrl runs it until released; one path turns every card, each shown whole on the stage's skip visits; any other
// input stops it and does only that. The pacing, the end stop and the input stop are exercised on the real stage in
// tests/e2e/stage-skip.mjs; these check the one path the stage wires.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../tavern-plugin/src/client/features/stage-runtime.js', import.meta.url), 'utf8')
const screen = source.slice(source.indexOf('function TavernStageScreen(props)'), source.indexOf('// 跳过 shows a card every 150 ms'))
const hold = screen.slice(screen.indexOf('const skipHoldBlocked'), screen.indexOf('// A click, → / Space / Enter'))

test('skip is the latched control or a held Ctrl, sharing one fast-forward path that ends on the round\'s last card', () => {
  assert.match(source, /const STAGE_SKIP_CARD_MS = 150, STAGE_SKIP_HOLD_MS = 160;/)
  assert.match(screen, /const skipping = skipLatch \|\| skipHeld/)
  // The control toggles only the latch (and ends auto paging); it shows on while Ctrl is held too. Auto ends a latched skip.
  assert.match(screen, /const toggleSkip = \(\) => \{ tavernStageRuntime\.setAuto\(id, false\); setSkipLatch\(value => !value\); \};/)
  assert.match(screen, /control\("skip", "跳过", "跳过", \{ className: skipping \? "is-on" : "", onClick: toggleSkip, "aria-pressed": skipping, title: "跳过（按住 Ctrl 快进）" \}, skipping\)/)
  assert.match(screen, /onClick: \(\) => \{ setSkipLatch\(false\); tavernStageRuntime\.setAuto\(id, !reader\.auto\); \}/)
  assert.doesNotMatch(screen, /page\(id, beats\.length - 1, "skip"\)/, 'no jump to the last page')
  // One card a step, the next page's first card on a skip visit (no voice, no performance), every card shown whole.
  assert.match(screen, /if \(atEnd && lastCard\) \{ stopSkip\(\); return undefined; \}\n\t\tif \(config \|\| backlog\) return undefined;/)
  assert.match(screen, /if \(!now\.last\) \{ setTypedVisit\(now\.visit \+ ":" \+ \(now\.turns \+ 1\)\); showCard\(now\.card \+ 1\); \}\n\t\t\telse tavernStageRuntime\.page\(id, index => index \+ 1, "skip"\);\n\t\t\}, STAGE_SKIP_CARD_MS\);/)
  assert.match(screen, /\|\| Boolean\(choice\.view\) \|\| skipping;/, 'a card shown while skipping is whole')
  assert.match(screen, /skipPossible\.current = !\(atEnd && lastCard\);/)
})

test('Ctrl arms after a short delay and releases on keyup; nothing arms when nothing is left to skip', () => {
  assert.ok(hold.length > 0)
  assert.match(hold, /if \(event\.key !== "Control"\) \{ interrupt\(event\); return; \}/)
  assert.match(hold, /function interrupt\(event\) \{[^]*?cancel\(\);\n\t\t\tif \(running\) setSkipLatch\(false\);/)
  assert.match(hold, /setTimeout\(\(\) => \{ timer = 0; if \(!skipPossible\.current\) return; tavernStageRuntime\.setAuto\(id, false\); setSkipHeld\(true\); \}, STAGE_SKIP_HOLD_MS\)/)
  assert.match(hold, /function onUp\(event\) \{ if \(event\.key === "Control"\) cancel\(\); \}/)
  assert.match(hold, /event\.repeat \|\| timer \|\| event\.altKey \|\| event\.shiftKey \|\| event\.metaKey/)
})

test('Ctrl shortcuts, clicks, wheels, focus loss and the stage\'s overlays never leave skip running; the stopping input does only that', () => {
  for (const name of ['wheel', 'pointerdown']) assert.match(hold, new RegExp(`addEventListener\\("${name}", interrupt, true\\)`))
  assert.match(hold, /addEventListener\("blur", cancel\)/)
  assert.match(hold, /visibilitychange/)
  assert.match(hold, /isContentEditable/)
  // The control's own press toggles it instead of stopping it.
  assert.match(hold, /event\.target\.closest\(STAGE_SKIP_CONTROL\)/)
  assert.match(source, /const STAGE_SKIP_CONTROL = '\[data-action="skip"\]';/)
  assert.match(hold, /if \(skipHoldBlocked\) \{ setSkipHeld\(false\); return undefined; \}/)
  assert.match(screen, /const skipHoldBlocked = Boolean\(config\) \|\| backlog;/)
  assert.match(hold, /return \(\) => \{\n\t\t\tclearTimeout\(timer\); setSkipHeld\(false\); skipStopped\.current = false;/)
  // advance(), back() and the wheel drop the input that stopped a fast-forward.
  for (const name of ['const advance = () => {', 'const back = () => {']) assert.ok(screen.includes(name + '\n\t\tif (skipStopped.current) { skipStopped.current = false; return; }'), name)
  assert.match(screen, /function wheel\(event\) \{[^]*?if \(skipStopped\.current\) \{ skipStopped\.current = false; return; \}[^]*?stageWheelDecision/)
})
