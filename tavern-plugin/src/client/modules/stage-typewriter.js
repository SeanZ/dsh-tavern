// 逐字显示 (features/stage-typewriter.js): a page's line is typed out glyph by glyph, at the reader's 文字速度
// (CONFIG › 文字, modules/stage-runtime.js `textSpeed`, milliseconds per glyph; 0 shows the whole line at once).
// A glyph is a grapheme (an emoji with its modifiers or a letter with its marks is one step).
const STAGE_GLYPH_SEGMENTER = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
function stageGlyphs(text) {
	const value = String(text || "");
	return STAGE_GLYPH_SEGMENTER ? Array.from(STAGE_GLYPH_SEGMENTER.segment(value), part => part.segment) : Array.from(value);
}
// Extra glyph steps to wait after glyphs[index]: after a sentence end (also behind its closing quote, 。」) and a
// line break, a shorter one after a comma; none inside a run of punctuation or at the end.
function stageGlyphPause(glyphs, index) {
	const closers = /^[」』）)】〉》”"’'］\]]$/u, next = glyphs[index + 1];
	if (next === undefined || closers.test(next) || /^[、，,。．.！!？?…‥：:；;～~—―]$/u.test(next)) return 0;
	let at = index;
	while (at > 0 && closers.test(glyphs[at])) at--;
	const glyph = glyphs[at];
	if (glyph === "\n" || /^[。．.！？!?…‥]$/u.test(glyph) && (glyph !== "." || /^\s$/.test(next))) return 5;
	if (/^[、，,；;：:～~]$/u.test(glyph)) return 2;
	if (/^[—―]$/u.test(glyph)) return 1;
	return 0;
}
// Milliseconds before glyphs[index + 1] shows: one step at the reader's speed, plus the pause after glyphs[index].
function stageGlyphDelay(glyphs, index, speed) {
	return speed * (1 + (index >= 0 ? stageGlyphPause(glyphs, index) : 0));
}
// How long a glyph fades in (tavern.css 「stage typewriter」 dsh-tavern-stage-glyph-in).
const STAGE_GLYPH_FADE_MS = 220;

// The skin's own way of showing text (dsh.skin/1 `textFx`). `type` is the plain typewriter above (a skin's `cps` may slow it,
// at most to 1.2x the reader's step). Every other reveal is cut-out animation shot "on twos": one even 12/s clock for the
// reveal steps and the glyph poses. 83.3 ms is exactly 5 frames at 60 Hz (10 at 120, 12 at 144), so every pose is held the
// same number of frames; the authored stepFps (6-14) only sets how many steps each pose holds. A glyph enters on its step in
// `poses` entrance poses (the reveal's own two, or textFx.poses), each held `hold` steps, then joins the shown text. A skin
// marked photosensitive types plainly.
const STAGE_SKIN_TEXT_FPS = 12;
function stageSkinReveal(skin, speed) {
	const fx = !skin || skin.photosensitive ? { reveal: "type" } : skin.textFx;
	const interval = 1000 / STAGE_SKIN_TEXT_FPS;
	const stepMs = fx.reveal === "type" ? Math.min(speed * 1.2, Math.max(speed, fx.cps ? 1000 / fx.cps : speed)) : interval;
	return { kind: fx.reveal, stepMs, chars: fx.reveal === "type" ? 1 : Math.max(fx.charsPerStep || 1, Math.ceil(interval / Math.max(1, speed))),
		chunk: fx.reveal === "type" ? 1 : fx.charsPerStep || 1, maxDurationScale: 1.2, speed,
		poses: fx.poses?.length || 2, hold: fx.stepFps ? Math.max(1, Math.round(STAGE_SKIN_TEXT_FPS / fx.stepFps)) : 1,
		jitter: fx.emphasis === "jitter" ? fx.jitter ?? 1 : 0, posed: fx.poses?.length || 0, emphasis: fx.emphasis || "" };
}
// Glyphs revealed on hop step `step` (1-based) when `shown` are already out. The reading speed stays the budget: step k may
// show floor(k * stepMs / speed) glyphs, in authored chunks (charsPerStep) - a slow reader gets held steps on the same 12/s
// grid instead of a slower clock. `stutter` hesitates (seeded, so a page replays the same), never stalling for good.
function stageSkinRevealCount(reveal, shown, step) {
	if (reveal.kind !== "stutter") {
		const due = Math.floor(step * reveal.stepMs / Math.max(1, reveal.speed));
		return shown < due ? Math.max(reveal.chunk || 1, due - shown) : 0;
	}
	const random = (Math.imul(step + 1, 1103515245) + 12345) >>> 0;
	return Math.max(random % (2 * reveal.chars + 1), Math.floor(step * reveal.stepMs / Math.max(1, reveal.speed * reveal.maxDurationScale)) - shown, 0);
}
// A glyph's seeded entrance offset for emphasis jitter: [x, y] em within ± jitter x 0.05em.
function stageSkinGlyphJitter(index, jitter) {
	const r = k => ((Math.imul(index * 2 + k + 1, 2654435761) >>> 0) % 1000) / 999 * 2 - 1;
	return [r(0), r(1)].map(value => Math.round(value * jitter * 50) / 1000);
}
