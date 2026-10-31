// Fork contract C7 (docs/plugin-api-ui.md「故事视图契约」): render one story floor the way
// Tavern's chat row does — its regex/beautified projection, Helper context and run policy —
// for a story-view plugin, as `tavernStory.render`. A live floor runs the card's HTML in
// Tavern's own message frames; any other floor is static: text, script-free HTML, or a
// snapshot, sanitized and shown in a shadow root so its styles stay inside the floor.
const TAVERN_FLOOR_SNAPSHOT_LIMIT = 512 * 1024;
const TAVERN_FLOOR_FRAME_TIMEOUT_MS = 1500;
const tavernFloorScriptPattern = /<(?:script|iframe|object|embed)\b/i;

// Static HTML that can sit in the host page, which shares DSH's origin and RPC: card HTML
// comes from third-party presets and cards, so only a whitelist survives (as in
// inline-fragment.js). Allowed elements are rebuilt one by one with allowed attributes;
// an unknown element gives way to its text and allowed children; dangerous or foreign-
// namespace subtrees (svg, math) go entirely. Controls stay inert, links open elsewhere,
// and html/body/:root rules apply to the floor (the shadow host).
const TAVERN_FLOOR_TAGS = new Set(["div", "span", "p", "img", "br", "hr", "b", "strong", "i", "em", "u", "s", "small", "sub", "sup", "mark", "del", "ins", "q", "cite", "abbr", "time", "blockquote", "pre", "code", "kbd",
	"ul", "ol", "li", "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col", "h1", "h2", "h3", "h4", "h5", "h6", "a",
	"details", "summary", "section", "article", "aside", "header", "footer", "nav", "main", "figure", "figcaption", "center", "style", "button", "input", "label", "progress", "meter"]);
const TAVERN_FLOOR_DROPPED = new Set(["svg", "math", "script", "iframe", "frame", "frameset", "object", "embed", "applet", "template", "form", "link", "meta", "base", "noscript", "portal", "textarea", "select"]);
const TAVERN_FLOOR_ATTRIBUTES = new Set(["class", "id", "style", "title", "alt", "src", "href", "width", "height", "colspan", "rowspan", "span", "open", "disabled", "checked", "value", "type", "role", "lang", "dir", "align", "min", "max", "low", "high", "optimum", "datetime", "start", "reversed", "for"]);
const TAVERN_FLOOR_INPUT_TYPES = new Set(["text", "checkbox", "radio", "range", "number", "button"]);
// Fork：仅故事静态正文的纯文本 details 复用宿主 Markdown，不改原文、正则或公共 HTML 渲染。
// 上游提供等价支持后，复跑 story-details 回归即可删除此适配及两个故事调用点。
// 只检查原始片段的顶层节点一次；嵌套/混合 HTML 不处理，绝不扫描 Markdown 的输出。
function tavernStoryDetailsParts(html, doc) {
	const template = doc.createElement("template");
	template.innerHTML = String(html || "");
	// 相邻块也可能共享作者样式或脚本；有这类内容时整段保留原渲染边界。
	if (template.content.querySelector("style, script, iframe, object, embed")) return null;
	const nodes = Array.from(template.content.childNodes);
	if (nodes.some(function (node) { return node.nodeType !== 1 ? node.nodeType !== 3 || node.data.trim() : node.localName !== "details"; })) return null;
	let changed = false;
	const parts = nodes.map(function (node) {
		if (node.nodeType === 3) return { text: node.data };
		const children = Array.from(node.childNodes), summary = node.firstElementChild;
		const split = children.indexOf(summary);
		if (Array.from(node.attributes).some(function (attr) { return attr.name !== "open"; }) || !summary || summary.localName !== "summary" || summary.attributes.length
			|| Array.from(summary.childNodes).some(function (child) { return child.nodeType !== 3; })
			|| children.slice(0, split).some(function (child) { return child.nodeType !== 3 || child.data.trim(); })
			|| children.slice(split + 1).some(function (child) { return child.nodeType !== 3; })) return { html: node.outerHTML };
		const text = children.slice(split + 1).map(function (child) { return child.data; }).join("");
		if (!text.trim()) return { html: node.outerHTML };
		changed = true;
		return { summary: summary.textContent, text: text, open: node.hasAttribute("open") };
	});
	return changed ? parts : null;
}

function TavernStoryStaticHtml(props) {
	const parts = React.useMemo(function () { return tavernStoryDetailsParts(props.html, window.document); }, [props.html]);
	const h = React.createElement;
	if (!parts) return h(TavernFloorStaticHtml, props);
	return h(React.Fragment, null, parts.map(function (part, index) {
		if (part.summary !== undefined) return h("details", { key: index, open: part.open }, h("summary", null, part.summary),
			h(TavernColoredMarkdown, { text: part.text, labels: tavernMarkdownLabels(tavernCodeLabels(key => key === "copy" ? "复制" : "已复制")) }));
		return part.html !== undefined ? h(TavernFloorStaticHtml, { key: index, html: part.html }) : part.text;
	}));
}

function tavernFloorUrl(value, image) {
	const url = String(value || "").replace(/[\u0000- \u007f]/g, "");
	if (/^https?:/i.test(url)) return true;
	if (image && /^data:image\//i.test(url)) return true;
	// Relative: no scheme at all (and not protocol-relative).
	return !/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^[\\/]{2}/.test(url);
}
// CSS that cannot load or run anything: no imports, legacy script hooks or script/non-image URLs.
function cleanTavernFloorCss(css) {
	return String(css || "").replace(/<\/?style/gi, "")
		.replace(/@import\b[^;]*;?/gi, "")
		.replace(/expression\s*\(/gi, "(")
		.replace(/(?:behavior|-moz-binding)\s*:[^;}]*;?/gi, "")
		.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, function (match, _quote, value) {
			const url = value.trim();
			return /\\/.test(url) || /^(?:javascript|vbscript):/i.test(url) || /^data:/i.test(url) && !/^data:image\//i.test(url) ? "none" : match;
		});
}
function sanitizeTavernFloorHtml(html, doc) {
	const template = doc.createElement("template");
	template.innerHTML = String(html || "");
	const output = doc.createElement("template");
	function copy(source, target) {
		for (const node of Array.from(source.childNodes)) {
			if (node.nodeType === 3) { target.appendChild(doc.createTextNode(node.data)); continue; }
			// The truncation marker of a bounded snapshot is the only comment kept.
			if (node.nodeType === 8) { if (node.data === " 已截断 ") target.appendChild(doc.createComment(node.data)); continue; }
			if (node.nodeType !== 1) continue;
			const tag = node.localName;
			if (node.namespaceURI !== "http://www.w3.org/1999/xhtml" || TAVERN_FLOOR_DROPPED.has(tag)) continue;
			if (!TAVERN_FLOOR_TAGS.has(tag)) { copy(node, target); continue; }
			const element = doc.createElement(tag);
			if (tag === "style") {
				element.textContent = cleanTavernFloorCss(node.textContent).replace(/(^|[{},]\s*)(?:html|body|:root)(?=[\s,{.:#\[>~+]|$)/g, "$1:host");
				target.appendChild(element);
				continue;
			}
			for (const attr of Array.from(node.attributes)) {
				const name = attr.name.toLowerCase();
				if (!(TAVERN_FLOOR_ATTRIBUTES.has(name) || /^(?:data|aria)-[a-z0-9_.-]+$/.test(name))) continue;
				if ((name === "src" || name === "href") && !tavernFloorUrl(attr.value, name === "src" && tag === "img")) continue;
				if (name === "type" && tag === "input" && !TAVERN_FLOOR_INPUT_TYPES.has(attr.value.toLowerCase())) continue;
				element.setAttribute(name, name === "style" ? cleanTavernFloorCss(attr.value) : attr.value);
			}
			if (tag === "a" && element.hasAttribute("href")) { element.setAttribute("target", "_blank"); element.setAttribute("rel", "noopener noreferrer"); }
			if (tag === "button" || tag === "input") { element.setAttribute("disabled", ""); if (tag === "button") element.setAttribute("type", "button"); }
			copy(node, element);
			target.appendChild(element);
		}
	}
	copy(template.content, output.content);
	return output.innerHTML;
}

function TavernFloorStaticHtml(props) {
	const ref = React.useRef(null);
	React.useLayoutEffect(function () {
		const root = ref.current;
		if (!root) return;
		const shadow = root.shadowRoot || root.attachShadow({ mode: "open" });
		const content = root.ownerDocument.createElement("div");
		content.className = "dsh-tavern-floor-content";
		content.innerHTML = sanitizeTavernFloorHtml(props.html, root.ownerDocument);
		shadow.replaceChildren(content);
		const colors = installTavernTextColors(content, {}, findTavernQuoteRanges);
		// The page keeps its place: a snapshot's form never submits, its controls stay inert.
		const stop = function (event) { event.preventDefault(); };
		shadow.addEventListener("submit", stop, true);
		const unbind = bindTavernFontZoom(root, root.ownerDocument.defaultView);
		return function () { shadow.removeEventListener("submit", stop, true); colors.dispose(); unbind(); shadow.innerHTML = ""; };
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
	 * revision?, containerRef?, fallbackText? }. Live runs the card HTML in message frames; otherwise
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
		const codeLabels = tavernCodeLabels(key => key === "copy" ? "复制" : "已复制");
		let body;
		if (!live && typeof props.snapshotHtml === "string") body = h(TavernStoryStaticHtml, { html: props.snapshotHtml });
		else {
			const floor = floorOf(state.view, storyTurn);
			if (!floor.projection) body = floor.waitingForHistory ? h("div", { role: "status" }, "正在读取历史内容…")
				: typeof props.fallbackText === "string" ? h(TavernColoredMarkdown, { text: props.fallbackText, labels: tavernMarkdownLabels(codeLabels), codeLabels: codeLabels }) : null;
			else if (live) body = renderTavernProjection(floor.projection, { sessionId: sessionId, turn: storyTurn, codeLabels: codeLabels,
				helperContext: floor.helperContext, helperContextReader: function () { return liveTavernView.getSnapshot(sessionId).view?.tavernHelper; },
				frameSizing: floor.frameSizing, trustedCardMode: floor.trustedCardMode, eagerFrame: props.eager === true, frameOwner: owner, executeSlash: executeSlash });
			else body = floor.parts.map(function (part, index) {
				return part.kind === "markdown"
					? h(TavernColoredMarkdown, { key: index, text: String(part.text || ""), labels: tavernMarkdownLabels(codeLabels), codeLabels: codeLabels })
					: h(TavernStoryStaticHtml, { key: index, html: String(part.content !== undefined ? part.content : part.html || "") });
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
