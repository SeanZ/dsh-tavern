// Fork contract C4 (docs/plugin-api.md「故事视图契约」): with the global storyViewMode
// setting on, a story-view plugin draws the story and Tavern stops drawing chat rows, so
// the chat view falls back to the host's own rendering. Off (the default) changes nothing.
// The last value read is cached per browser, so a page opened in story view mode does not
// mount Tavern rows (and their card iframes) first and drop them once the setting loads.
function createTavernStoryViewMode(host) {
	const key = "dsh-tavern:story-view-mode";
	const listeners = new Set();
	let enabled = false, loading = null;
	try { enabled = host.localStorage.getItem(key) === "1"; } catch (_) {}
	function apply(value) {
		const next = value === true;
		try { host.localStorage.setItem(key, next ? "1" : "0"); } catch (_) {}
		if (next === enabled) return;
		enabled = next;
		listeners.forEach(function (listener) { listener(); });
	}
	function refresh() {
		if (!loading) loading = rpc("getTavernSettings").then(function (result) { apply(result && result.settings && result.settings.storyViewMode); }, function () {})
			.then(function () { loading = null; });
		return loading;
	}
	return Object.freeze({
		enabled: function () { return enabled; },
		subscribe: function (listener) { listeners.add(listener); return function () { listeners.delete(listener); }; },
		refresh: refresh,
		async set(value) {
			if (typeof value !== "boolean") throw new Error("故事视图模式设置必须是布尔值");
			const result = await rpc("updateTavernSettings", { patch: { storyViewMode: value } });
			apply(result && result.settings && result.settings.storyViewMode);
			return enabled;
		},
		start: function () {
			void refresh();
			// Another tab changed it: its write to the cache reaches this tab as a storage event.
			const onStorage = function (event) { if (event.key === key) apply(event.newValue === "1"); };
			if (typeof host.addEventListener !== "function") return function () {};
			host.addEventListener("storage", onStorage);
			return function () { host.removeEventListener("storage", onStorage); };
		}
	});
}
const tavernStoryViewMode = createTavernStoryViewMode(window);
// An effect that keeps `register()` (returning its disposer) active only while Tavern
// draws the chat rows, re-registering when the setting changes.
function whileTavernDrawsChat(register) {
	return function () {
		let dispose = null;
		function sync() {
			const wanted = !tavernStoryViewMode.enabled();
			if (wanted && !dispose) dispose = register() || function () {};
			else if (!wanted && dispose) { const release = dispose; dispose = null; release(); }
		}
		sync();
		const stop = tavernStoryViewMode.subscribe(sync);
		return function () { stop(); if (dispose) dispose(); dispose = null; };
	};
}
// 故事视图模式下由楼层操作与输入框状态条承担的 dock 入口（重新生成正文、重放与撤回失败轮、
// 编辑正文、回退本轮等）随开关即时隐藏；关闭时与上游一致。
function useTavernStoryViewMode() {
	return React.useSyncExternalStore(tavernStoryViewMode.subscribe, tavernStoryViewMode.enabled, tavernStoryViewMode.enabled);
}
