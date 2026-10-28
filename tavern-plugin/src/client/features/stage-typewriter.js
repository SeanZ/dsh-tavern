// 逐字显示: the stage's text box types its line out (modules/stage-typewriter.js), each glyph fading in. The whole line is laid
// out from the start (the glyphs not shown yet are transparent), so nothing re-wraps while it types and a screen reader reads
// the whole line. Only the glyphs still fading in are separate elements; the shown text is one run and the rest another, so a
// settled line paints exactly as plain text. props: { text, speed (ms per glyph; 0 or instant: all at once), instant,
// reveal (the skin's textFx, stageSkinReveal), onDone() }.
// A skin's stepped reveal (any textFx.reveal but type) is cut-out animation on twos: one frame-quantized clock (absolute from
// its start, read at the frame's own time) drives both the reveal steps and every glyph's pose, so poses never drift off the
// steps and each is held the same number of display frames. A glyph enters on one step (hop 0), lands on the next (hop 1, or
// through the skin's own poses) and then joins the shown run; there are no CSS animation timers. A long task skips poses
// rather than slowing the reading. The line reports done once its last glyphs have landed.
function TavernStageTypewriter(props) {
	const h = React.createElement;
	const speed = props.speed == null ? STAGE_READING_DEFAULTS.textSpeed : props.speed;
	const instant = Boolean(props.instant) || !(speed > 0);
	const reveal = props.reveal || null, stepped = Boolean(reveal) && reveal.kind !== "type" && !instant;
	const glyphs = React.useMemo(() => stageGlyphs(props.text), [props.text]);
	const fontsReady = useTavernStageFontsReady();
	const [shown, setShown] = React.useState(instant ? glyphs.length : 0);
	const visible = instant ? glyphs.length : Math.min(shown, glyphs.length);
	const [settled, setSettled] = React.useState(-1);
	// The hop clock (stepped reveals): the current step and the step each glyph appeared on.
	const [step, setStep] = React.useState(0);
	const hop = React.useRef({ step: 0, t0: null, base: 0, born: [] });
	const onDone = React.useRef(props.onDone);
	onDone.current = props.onDone;
	React.useEffect(function () {
		if (stepped) return undefined;
		if (visible >= glyphs.length && onDone.current) onDone.current();
		if (instant || !fontsReady || visible >= glyphs.length) {
			const timer = setTimeout(() => setSettled(visible), STAGE_GLYPH_FADE_MS + 40);
			return () => clearTimeout(timer);
		}
		const timer = setTimeout(() => setShown(visible + 1), stageGlyphDelay(glyphs, visible - 1, reveal ? reveal.stepMs : speed));
		return () => clearTimeout(timer);
	}, [visible, glyphs, instant, fontsReady, speed, stepped, reveal && reveal.stepMs]);
	React.useEffect(function () {
		if (!stepped || !fontsReady) return undefined;
		const state = hop.current, landedAt = visible > 0 ? (state.born[visible - 1] ?? 0) + reveal.poses * reveal.hold : 0;
		if (visible >= glyphs.length && state.step >= landedAt) {
			state.t0 = null;
			if (onDone.current) onDone.current();
			return undefined;
		}
		let frame = null;
		const tick = function (now) {
			if (state.t0 === null) { state.t0 = now; state.base = state.step + 1; }
			// 2 ms absorbs frame timestamp jitter without moving a step across a frame boundary (a 144 Hz frame is 6.9 ms).
			const at = state.base + Math.floor((now - state.t0 + 2) / reveal.stepMs);
			if (at <= state.step) { frame = requestAnimationFrame(tick); return; }
			let next = visible;
			for (let k = state.step + 1; k <= at; k++) {
				const count = next < glyphs.length ? Math.min(glyphs.length - next, stageSkinRevealCount(reveal, next, k)) : 0;
				for (let i = next; i < next + count; i++) state.born[i] = k;
				next += count;
			}
			state.step = at; frame = null;
			setShown(next); setStep(at);
		};
		frame = requestAnimationFrame(tick);
		return () => { if (frame !== null) cancelAnimationFrame(frame); };
	}, [stepped, fontsReady, visible, glyphs, step, reveal]);
	// Glyphs before `settled` finished fading earlier, so they join the shown run; a stepped glyph joins it once it has landed.
	const tail = Math.ceil(STAGE_GLYPH_FADE_MS / Math.max(1, speed)) + 1;
	const span = stepped ? reveal.poses * reveal.hold : 0;
	const landing = stepped ? hop.current.born.findIndex((born, i) => i < visible && born + span > step) : -1;
	const done = instant ? visible : stepped ? (landing < 0 ? visible : landing) : Math.min(visible, Math.max(0, settled, visible - tail));
	// data-typed: the line is typed (a stepped one once its last glyphs landed), as onDone reports it.
	const complete = visible >= glyphs.length && landing < 0;
	return h("span", { className: "dsh-tavern-stage-type" + (instant ? " is-instant" : ""), "data-typed": complete ? "" : undefined,
		"data-skin-reveal": stepped ? reveal.kind : undefined, "data-skin-poses": stepped && reveal.posed ? reveal.posed : undefined, "data-skin-emphasis": stepped && reveal.emphasis || undefined },
		done > 0 ? h("span", { key: "shown", className: "dsh-tavern-stage-type-shown" }, glyphs.slice(0, done).join("")) : null,
		glyphs.slice(done, visible).map((glyph, index) => {
			const at = done + index, jitter = stepped && reveal.jitter ? stageSkinGlyphJitter(at, reveal.jitter) : null;
			// The glyph keeps its place in the line; a copy over it is what poses (its age in steps: data-hop).
			return h("span", { key: at, className: "dsh-tavern-stage-glyph" }, glyph,
				stepped ? h("span", { className: "dsh-tavern-stage-glyph-paint", "data-glyph": glyph, "aria-hidden": true,
					"data-hop": Math.min(reveal.poses, Math.floor((step - (hop.current.born[at] ?? step)) / reveal.hold)),
					style: jitter ? { "--gj-x": jitter[0] + "em", "--gj-y": jitter[1] + "em" } : undefined }) : null);
		}),
		visible < glyphs.length ? h("span", { key: "rest", className: "dsh-tavern-stage-type-rest" }, glyphs.slice(visible).join("")) : null);
}

// Typing starts once the page's fonts have loaded (a glyph laid out in a fallback face would move when the font arrives), or
// after 800 ms whatever they do.
function useTavernStageFontsReady() {
	const fonts = typeof document !== "undefined" ? document.fonts : null;
	const [ready, setReady] = React.useState(() => !fonts || fonts.status === "loaded");
	React.useEffect(function () {
		if (ready) return undefined;
		let live = true;
		const done = () => { if (live) setReady(true); };
		fonts.ready.then(done, done);
		const timer = setTimeout(done, 800);
		return () => { live = false; clearTimeout(timer); };
	}, []);
	return ready;
}

// CONFIG › 文字's preview: a sample line typed at the chosen speed, then held for the auto wait (as a silent page would be),
// then again. The next-page cue shows while it waits.
const STAGE_CONFIG_SAMPLE = "夕阳把走廊染成了橘色。她停下脚步，回头看了你一眼。";
function TavernStageConfigPreview(props) {
	const h = React.createElement, reading = props.reading;
	const [round, setRound] = React.useState(0), [done, setDone] = React.useState(false);
	React.useEffect(function () { setDone(false); setRound(n => n + 1); }, [reading.textSpeed, reading.autoWait, reading.autoSpeed]);
	React.useEffect(function () {
		if (!done) return undefined;
		const timer = setTimeout(() => { setDone(false); setRound(n => n + 1); }, Math.min(6000, stageAutoDelay(reading, false, STAGE_CONFIG_SAMPLE)));
		return () => clearTimeout(timer);
	}, [done]);
	return h("div", { className: "dsh-tavern-stage-config-preview", "aria-hidden": true },
		h("span", { className: "dsh-tavern-stage-config-preview-name" }, "预览"),
		h("div", { className: "dsh-tavern-stage-config-preview-text" },
			h(TavernStageTypewriter, { key: round, text: STAGE_CONFIG_SAMPLE, speed: reading.textSpeed, onDone: () => setDone(true) }),
			done ? h("i", { className: "dsh-tavern-stage-config-preview-next" }) : null));
}
