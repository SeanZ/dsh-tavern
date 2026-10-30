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
