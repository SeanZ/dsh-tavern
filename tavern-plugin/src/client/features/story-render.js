// Fork contract C7 (docs/plugin-api.md「故事视图契约」): render one story floor the way
// Tavern's chat row does — its regex/beautified projection, Helper context and run policy —
// for a story-view plugin, as `tavernStory.render`. A live floor runs the card's HTML in
// Tavern's own message frames; any other floor is static: text, script-free HTML, or a
// snapshot, sanitized and shown in a shadow root so its styles stay inside the floor.
const TAVERN_FLOOR_SNAPSHOT_LIMIT = 512 * 1024;
const TAVERN_FLOOR_FRAME_TIMEOUT_MS = 1500;
const tavernFloorScriptPattern = /<(?:script|iframe|object|embed)\b/i;

// Static HTML that can sit in the host page: no scripts, frames, handlers or script URLs;
// links open elsewhere; html/body/:root rules apply to the floor (the shadow host).
function sanitizeTavernFloorHtml(html, doc) {
	const template = doc.createElement("template");
	template.innerHTML = String(html || "");
	for (const node of Array.from(template.content.querySelectorAll("script, iframe, frame, frameset, object, embed, applet, base, meta, noscript, template, portal"))) node.remove();
	for (const node of Array.from(template.content.querySelectorAll("link"))) if (!/^\s*stylesheet\s*$/i.test(node.getAttribute("rel") || "")) node.remove();
	for (const node of Array.from(template.content.querySelectorAll("*"))) {
		for (const attr of Array.from(node.attributes)) {
			const name = attr.name.toLowerCase();
			const value = attr.value.replace(/[\u0000- ]/g, "");
			if (name.startsWith("on") || name === "srcdoc" || name === "formaction" || name === "action" || name === "is" || name === "autofocus") node.removeAttribute(attr.name);
			else if (["href", "src", "xlink:href", "poster", "background"].includes(name) && (/^(?:javascript|vbscript):/i.test(value) || /^data:/i.test(value) && !/^data:image\//i.test(value))) node.removeAttribute(attr.name);
		}
		if (node.tagName === "A" && node.hasAttribute("href")) { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
		if (node.tagName === "STYLE") node.textContent = node.textContent.replace(/(^|[{},]\s*)(?:html|body|:root)(?=[\s,{.:#\[>~+]|$)/g, "$1:host");
	}
	return template.innerHTML;
}

function TavernFloorStaticHtml(props) {
	const ref = React.useRef(null);
	React.useLayoutEffect(function () {
		const root = ref.current;
		if (!root) return;
		const shadow = root.shadowRoot || root.attachShadow({ mode: "open" });
		shadow.innerHTML = sanitizeTavernFloorHtml(props.html, root.ownerDocument);
		// The page keeps its place: a snapshot's form never submits, its controls stay inert.
		const stop = function (event) { event.preventDefault(); };
		shadow.addEventListener("submit", stop, true);
		const unbind = bindTavernFontZoom(root, root.ownerDocument.defaultView);
		return function () { shadow.removeEventListener("submit", stop, true); unbind(); shadow.innerHTML = ""; };
	}, [props.html]);
	return React.createElement("div", { ref: ref, className: "mes_text dsh-tavern-floor-static" });
}

// The DOM a message frame shows now, through its bounded snapshot channel. A trusted
// frame shares this page's origin and is read directly; a sandboxed one answers the
// channel's message (the token sits in its runtime reporter).
function captureTavernFloorFrame(frame, budget) {
	try {
		const body = frame.contentDocument && frame.contentDocument.body;
		if (body) return Promise.resolve(captureTavernBoundedDom(body, budget));
	} catch (_) {}
	const match = /var token=("(?:[^"\\]|\\.)*");var domAllowed=true/.exec(String(frame.getAttribute("srcdoc") || frame.srcdoc || ""));
	const target = frame.contentWindow;
	if (!match || !target) return Promise.resolve(null);
	const token = JSON.parse(match[1]), host = frame.ownerDocument.defaultView;
	return new Promise(function (resolve) {
		let timer = null;
		function done(value) { host.removeEventListener("message", receive); host.clearTimeout(timer); resolve(value); }
		function receive(event) {
			const data = event.data;
			if (event.source !== target || !data || data.token !== token || data.type !== "dsh-tavern-frame-runtime" || data.explicit !== true) return;
			done({ dom: String(data.runtime && data.runtime.dom || ""), truncated: /<!-- 已截断 -->$/.test(String(data.runtime && data.runtime.dom || "")) });
		}
		host.addEventListener("message", receive);
		timer = host.setTimeout(function () { done(null); }, TAVERN_FLOOR_FRAME_TIMEOUT_MS);
		target.postMessage({ type: "dsh-tavern-frame-dom-snapshot", token: token }, "*");
	});
}

function createTavernStoryRender(options) {
	const executeSlash = options && options.executeSlash;
	function viewOf(sessionId) {
		const state = liveTavernView.getSnapshot(sessionId);
		if (state.view) return Promise.resolve(state.view);
		return new Promise(function (resolve, reject) {
			let settled = false, stop = null;
			function check(next) {
				if (settled || !(next.view || next.phase === "error")) return;
				settled = true;
				if (stop) stop();
				if (next.view) resolve(next.view); else reject(new Error(next.error || "读取本局状态失败"));
			}
			stop = liveTavernView.subscribe(sessionId, check);
			if (settled) stop();
		});
	}
	function floorOf(view, storyTurn) {
		const projection = tavernProjectionForTurn(view, storyTurn);
		const parts = projectionPartsOf(projection);
		const policy = view && view.tavernRuntimePolicy || {};
		const latestTurn = tavernLatestProjectionTurn(view);
		return {
			storyTurn: storyTurn, mode: view && view.mode || "", projection: projection, parts: parts,
			hasScript: parts.some(function (part) { return part.kind === "html" && tavernFloorScriptPattern.test(String(part.content !== undefined ? part.content : part.html || "")); }),
			helperContext: view && view.tavernHelper || null, frameSizing: policy.frameSizing, trustedCardMode: policy.trustedCardMode === true,
			latestTurn: latestTurn,
			// Older floors outside Tavern's history window have no projection until it grows.
			waitingForHistory: !projection && Boolean(view && view.historyWindow) && storyTurn < latestTurn
		};
	}

	/**
	 * One floor's body. props: { sessionId, storyTurn, live?, snapshotHtml?, eager?, owner?,
	 * revision?, containerRef? }. Live runs the card HTML in message frames; otherwise
	 * snapshotHtml, or the projection with script-free static HTML.
	 */
	function FloorBody(props) {
		const sessionId = props.sessionId, storyTurn = Number(props.storyTurn) || 0, live = props.live === true;
		const paths = [["mode"], ["tavernRuntimePolicy"], ["historyWindow"], ["$projectionTurn", String(storyTurn)], ["$projectionLatestTurn", String(storyTurn)]].concat(live ? [["tavernHelper"]] : []);
		// Subscribed to this floor's paths only; the projection is read from the whole view.
		const state = useLiveTavernView(sessionId, String(props.revision || ""), paths);
		// The page owns no iframe for it: Tavern keeps message frames alive when React lets go
		// (retained frames); a floor that stops being live releases its frames at once.
		const fallbackOwner = React.useRef(null);
		if (!fallbackOwner.current) fallbackOwner.current = { sessionId: sessionId, storyTurn: storyTurn };
		const owner = props.owner || fallbackOwner.current;
		React.useEffect(function () {
			if (!live) return;
			return function () { tavernRetainedFrames.invalidateOwner(owner); };
		}, [live, owner]);
		const h = React.createElement;
		const codeLabels = { copyLabel: "复制", copiedLabel: "已复制" };
		let body;
		if (!live && typeof props.snapshotHtml === "string") body = h(TavernFloorStaticHtml, { html: props.snapshotHtml });
		else {
			const floor = floorOf(state.view, storyTurn);
			if (!floor.projection) body = floor.waitingForHistory ? h("div", { role: "status" }, "正在读取历史内容…") : null;
			else if (live) body = renderTavernProjection(floor.projection, { sessionId: sessionId, turn: storyTurn, codeLabels: codeLabels,
				helperContext: floor.helperContext, helperContextReader: function () { return liveTavernView.getSnapshot(sessionId).view?.tavernHelper; },
				frameSizing: floor.frameSizing, trustedCardMode: floor.trustedCardMode, eagerFrame: props.eager === true, frameOwner: owner, executeSlash: executeSlash });
			else body = floor.parts.map(function (part, index) {
				return part.kind === "markdown"
					? h(TavernColoredMarkdown, { key: index, text: String(part.text || ""), labels: { code: codeLabels, footnotes: "脚注" }, codeLabels: codeLabels })
					: h(TavernFloorStaticHtml, { key: index, html: String(part.content !== undefined ? part.content : part.html || "") });
			});
		}
		return h("div", { ref: props.containerRef, className: "dsh-tavern-assistant dsh-tavern-floor-body", "data-tavern-floor": String(storyTurn), "data-live": live || undefined }, body);
	}

	return Object.freeze({
		/** The floor's projection, Helper context and run policy from the Tavern view. */
		projectFloor: async function (sessionId, storyTurn) {
			const turn = tavernStoryTurnArgument(storyTurn, "projectFloor");
			return floorOf(await viewOf(tavernStorySessionArgument(sessionId, "projectFloor")), turn);
		},
		/** Extend Tavern's history window one page back, for floors still waiting for it. */
		loadOlderProjections: async function (sessionId) {
			const view = await viewOf(tavernStorySessionArgument(sessionId, "loadOlderProjections"));
			if (!view.historyWindow) return false;
			await requestOlderHistory(sessionId, view.historyWindow.from);
			return true;
		},
		/** A player input's display template (by its native turn), unless the input was edited. */
		readInputTemplate: async function (sessionId, inputTurn) {
			const view = await viewOf(tavernStorySessionArgument(sessionId, "readInputTemplate"));
			const key = String(Number(inputTurn) || 0);
			if (typeof view.userInputEdits?.[key] === "string") return null;
			const html = view.inputTemplateDisplays?.[key];
			return typeof html === "string" && html !== "" ? html : null;
		},
		FloorBody: FloorBody,
		StaticHtml: TavernFloorStaticHtml,
		sanitizeHtml: function (html) { return sanitizeTavernFloorHtml(html, window.document); },
		/**
		 * Static HTML of what a floor shows now: its message frames through their bounded
		 * snapshot channel, other parts from the page. Returns { html, truncated, frames, missed }.
		 */
		captureFloorSnapshot: async function (element, budget) {
			if (!element || element.nodeType !== 1) throw new TypeError("captureFloorSnapshot 需要楼层容器或 iframe 元素");
			const doc = element.ownerDocument;
			const sources = element.tagName === "IFRAME" ? [element] : Array.from(element.children);
			let html = "", truncated = false, frames = 0, missed = 0;
			for (const node of sources) {
				const frame = node.tagName === "IFRAME" ? node : node.querySelector && node.querySelector("iframe.dsh-tavern-message-frame:not([aria-hidden=\"true\"])");
				let piece;
				if (frame) {
					const captured = await captureTavernFloorFrame(frame, budget);
					if (captured) { frames += 1; piece = captured; }
					else { missed += 1; continue; }
				} else piece = captureTavernBoundedDom(node, budget);
				const part = node.tagName === "IFRAME" ? piece.dom : "<div>" + piece.dom + "</div>";
				if (html.length + part.length > TAVERN_FLOOR_SNAPSHOT_LIMIT) { truncated = true; break; }
				html += part;
				truncated = truncated || piece.truncated === true;
			}
			return { html: sanitizeTavernFloorHtml(html, doc), truncated: truncated, frames: frames, missed: missed };
		}
	});
}
