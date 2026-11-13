// 故事适配器只使用显式传入的上游能力；接线集中于 bindings.js。
function createStoryRenderAdapter(dependencies) {
	const {
			window,
		storyTranscript,
		React,
		BODY_RENDER_VERSION,
		TavernAutomaticStatusRuntime,
		createBodyRenderPlan,
		prepareTavernBodyGroup,
		TavernBodyGroup,
		TavernBodyMarkdown,
		sanitizeTavernBodyHtml,
		liveTavernView,
		projectionPartsOf,
		tavernLatestProjectionTurn,
		useLiveTavernView,
		useTavernUiExtensions,
		useTavernCardPluginScopes,
		isPlayMode,
		useTavernPluginMedia,
		createTavernPluginTextContext,
		tavernRetainedFrames,
		tavernCodeLabels,
		tavernMarkdownLabels,
		renderTavernProjection,
		TavernPluginMediaItem,
		TavernIllustrationDraft,
		tavernUiExtensions,
		tavernPluginAllowed,
		assistantRendererFeature,
		captureTavernBoundedDom,
		installTavernTextColors,
		findTavernQuoteRanges,
		bindTavernFontZoom,
		tavernStorySessionArgument,
	} = dependencies;

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
    function tavernFloorDynamicNode(node) {
        return node.nodeType === 1 && (node.classList.contains("dsh-tavern-plugin-media") || node.hasAttribute("data-tavern-story-dynamic"));
    }
    function sanitizeTavernFloorHtml(html, doc, snapshot) {
        return sanitizeTavernBodyHtml(html, doc, { mode: "static", snapshot, controls: true });
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
		function floorOf(view, floor) {
			const storyTurn = floor.legacyTurn;
			const projection = floor.projection;
			const parts = createBodyRenderPlan(projection);
			const policy = view && view.tavernRuntimePolicy || {};
			const latestTurn = tavernLatestProjectionTurn(view);
			return {
				storyTurn: storyTurn, mode: view && view.mode || "", projection: projection, parts: parts,
				hasScript: parts.some(function (part) { return part.kind === "html" && tavernFloorScriptPattern.test(String(part.content !== undefined ? part.content : part.html || "")); }),
				helperContext: view && view.tavernHelper || null, frameSizing: policy.frameSizing, trustedCardMode: policy.trustedCardMode === true,
				latestTurn: latestTurn,
				// Older floors outside Tavern's history window have no projection until it grows.
				waitingForHistory: false
			};
		}

		/**
		 * One floor's body. props: { sessionId, floor, live?, snapshotHtml?, eager?, owner?,
		 * revision?, containerRef?, fallbackText? }. Live runs the card HTML in message frames; otherwise
		 * snapshotHtml, or the projection with script-free static HTML.
		 */
		function FloorBody(props) {
			const sessionId = props.sessionId, storyTurn = Number(props.floor?.legacyTurn) || 0, live = props.live === true;
			const paths = [["mode"], ["tavernRuntimePolicy"], ["historyWindow"], ["$projectionTurn", String(storyTurn)], ["$projectionLatestTurn", String(storyTurn)]].concat(live ? [["tavernHelper"]] : []);
			// Subscribed to this floor's paths only; the projection is read from the whole view.
			const state = useLiveTavernView(sessionId, String(props.revision || ""), paths);
			useTavernUiExtensions();
			useTavernCardPluginScopes();
			const play = isPlayMode(state.view && state.view.mode) && storyTurn > 0;
			const pluginMedia = useTavernPluginMedia(sessionId, storyTurn, play);
			const items = play ? pluginMedia.items : [];
			const pluginText = play ? createTavernPluginTextContext({ items: items, sessionId: sessionId, turn: storyTurn, streaming: false }) : null;
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
			const markdown = function (text, key) { return h(TavernBodyMarkdown, { key: key, text: text, static: true, labels: tavernMarkdownLabels(codeLabels), codeLabels: codeLabels }); };
			const renderMarkdown = function (text, key) { return pluginText ? pluginText.render(text, key, markdown) : markdown(text, key); };
			let body;
			if (!live && typeof props.snapshotHtml === "string") body = h(TavernFloorStaticHtml, { html: props.snapshotHtml });
			else {
				const floor = floorOf(state.view, props.floor);
				if (!floor.projection) body = floor.waitingForHistory ? h("div", { role: "status" }, "正在读取历史内容…")
					: typeof props.fallbackText === "string" ? renderMarkdown(props.fallbackText) : null;
				else if (live) body = renderTavernProjection(floor.projection, { sessionId: sessionId, turn: storyTurn, codeLabels: codeLabels,
					helperContext: floor.helperContext, helperContextReader: function () { return liveTavernView.getSnapshot(sessionId).view?.tavernHelper; },
					frameSizing: floor.frameSizing, trustedCardMode: floor.trustedCardMode, eagerFrame: props.eager === true, frameOwner: owner, executeSlash: executeSlash, plugin: pluginText });
				else body = floor.parts.map(function (part, index) {
					if (part.kind === "body") return h(TavernBodyGroup, { key: part.frameIndex, text: part.text, static: true,
                        prepared: prepareTavernBodyGroup(part, floor.projection.parts || projectionPartsOf(floor.projection), { plugin: pluginText, static: true, sessionId }),
                        labels: tavernMarkdownLabels(codeLabels), codeLabels });
					const html = String(part.content !== undefined ? part.content : part.html || "");
					const marked = pluginText && pluginText.renderHtmlMarkers(html);
					return h(React.Fragment, { key: index }, h(TavernFloorStaticHtml, { html: marked ? marked.html : html }), marked && marked.after);
				});
			}
			// 复用上游媒体索引、锚点和图片操作；未命中锚点的图片放在正文后，快照不固化动态图片。
			const trailing = items.filter(function (item) { return !(pluginText && pluginText.placed.has(item.id)); });
			return h("div", { ref: props.containerRef, className: "dsh-tavern-assistant dsh-tavern-floor-body", "data-tavern-floor": String(storyTurn), "data-live": live || undefined }, body,
				h("div", { "data-tavern-story-dynamic": "" },
					trailing.map(function (item) { return h(TavernPluginMediaItem, { key: item.id, item: item, sessionId: sessionId, turn: storyTurn }); }),
					play ? h(TavernIllustrationDraft, { sessionId: sessionId, turn: storyTurn, items: items }) : null));
		}
		function IllustrateAction(props) {
			const state = useLiveTavernView(props.sessionId, "", [["mode"]]);
			useTavernUiExtensions();
			useTavernCardPluginScopes();
			const turn = Number(props.storyTurn) || 0;
			const illustrator = isPlayMode(state.view && state.view.mode) && turn > 0 ? tavernUiExtensions.illustrator() : null;
			return illustrator && tavernPluginAllowed(illustrator.owner, props.sessionId)
				? React.createElement(assistantRendererFeature.IllustrateAction, { key: props.sessionId + ":" + turn, sessionId: props.sessionId, turn: turn, illustrator: illustrator, disabled: props.disabled, className: props.className }) : null;
		}

		return Object.freeze({
			/** 读取楼层投影、Helper 上下文和运行策略；storyTurn 参数接收楼层的消息 target。 */
			projectFloor: async function (sessionId, storyTurn) {
				const floor = storyTranscript.resolve(sessionId, storyTurn);
				return floorOf(await viewOf(tavernStorySessionArgument(sessionId, "projectFloor")), floor);
			},
			/** Extend Tavern's history window one page back, for floors still waiting for it. */
			loadOlderProjections: storyTranscript.older,


			rendererVersion: BODY_RENDER_VERSION,
			AutomaticStatus: function (props) { return React.createElement(TavernAutomaticStatusRuntime, { ...props, executeSlash }); },
			FloorBody: FloorBody,
			IllustrateAction: IllustrateAction,
			StaticHtml: TavernFloorStaticHtml,
			sanitizeHtml: function (html) { return sanitizeTavernFloorHtml(html, window.document); },
			/**
			 * 读取当前楼层的静态 HTML：消息 frame 通过有超时限制的快照通道获取，其它部分从页面读取。
			 * 返回 { rendererVersion, html, truncated, frames, missed }。
			 */
			captureFloorSnapshot: async function (element, budget) {
				if (!element || element.nodeType !== 1) throw new TypeError("captureFloorSnapshot 需要楼层容器或 iframe 元素");
				const doc = element.ownerDocument;
				const sources = element.tagName === "IFRAME" ? [element] : Array.from(element.children);
				let html = "", truncated = false, frames = 0, missed = 0;
				for (const node of sources) {
					if (tavernFloorDynamicNode(node)) continue;
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
				return { rendererVersion: BODY_RENDER_VERSION, html: sanitizeTavernFloorHtml(html, doc, true), truncated: truncated, frames: frames, missed: missed };
			}
		});
	}

	return { createTavernStoryRender };
}

export { createStoryRenderAdapter };
