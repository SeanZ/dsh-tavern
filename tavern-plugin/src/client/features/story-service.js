// @include-domain story-rounds.js

// Fork contract C5 (docs/plugin-api.md「故事视图契约」): the browser service `tavernStory`
// a story-view plugin injects. Floor actions call the same RPCs and client flows as the dock
// controls (play-controls.js); this file adds no story rules of its own.
const TAVERN_STORY_FAILED_ENDS = ["error", "aborted", "interrupted"];
// One `rollbackTurn` removes one round (or first clears a failed tail); a jump of more
// floors than this is refused rather than looped through.
const TAVERN_STORY_MAX_ROLLBACK_STEPS = 100;
// 重新结算的指导意见上限，与旧聊天行「重新结算变量」对话框相同。
const TAVERN_STORY_GUIDANCE_MAX = 4000;

function tavernStoryTurnArgument(value, label) {
	const turn = Number(value);
	if (!Number.isSafeInteger(turn) || turn < 1) throw new TypeError(label + " 需要正整数楼层轮次");
	return turn;
}
function tavernStorySessionArgument(value, label) {
	if (typeof value !== "string" || value === "") throw new TypeError(label + " 需要 sessionId");
	return value;
}
function tavernStoryEvents(entries) {
	const events = [];
	for (const entry of entries || []) if (entry && entry.type === "event" && entry.event) events.push(entry.event);
	return events;
}
// 流式正文预览最多每 100 ms 回调一次；楼层或尝试变化时立即回调。
const TAVERN_STORY_LIVE_TEXT_MS = 100;
// 运行中回合的流式正文：宿主事件窗口里的临时条目 `assistant/live-chunk`（text-delta），按尝试拼接。
// 一次尝试落定时宿主用 settle-assistant 撤掉它的临时条目，所以窗口里只剩还在生成的那次。
function tavernStoryLiveChunk(live, entry) {
	const data = entry && entry.type === "transient" && entry.event && entry.event.data;
	if (!data || !data.chunk || data.chunk.type !== "text-delta") return live;
	const text = String(data.chunk.text || "");
	if (live && live.attemptId === data.attemptId && live.turn === data.turn) return { attemptId: live.attemptId, turn: live.turn, text: live.text + text };
	return { attemptId: data.attemptId, turn: data.turn, text: text };
}
function tavernStoryLiveOf(entries) {
	let live = null;
	for (const entry of entries || []) live = tavernStoryLiveChunk(live, entry);
	return live;
}
// 最新楼层的后台结算（变量、姿态等）仍在等待或运行：与 Tavern 视图 activity 同一判定（readActivity）。
function tavernStorySettling(view) {
	const activity = view && view.activity;
	return Boolean(activity) && (activity.busy === true || activity.phase === "pending");
}
const TAVERN_STORY_SETTLING_ERROR = "正在结算，稍候再试";
// 最新楼层的后台结算状态（视图 settleStatus / settlementTurn / settleError）；视图未读到时为 null。
function tavernStorySettlement(view) {
	if (!view) return null;
	const status = tavernStorySettling(view) || view.settleStatus === "running" ? "running" : view.settleStatus === "error" ? "error" : "idle";
	const turn = Number(view.settlementTurn);
	return Object.freeze({
		status: status,
		turn: Number.isSafeInteger(turn) && turn > 0 ? turn : null,
		error: status === "error" ? tavernStoryClip(view.settleError || "后台结算失败，请重试。", TAVERN_STORY_RECEIPT_LIMITS.text) : null
	});
}
// 每楼 MVU 回执只做展示投影（同旧聊天行 TavernMvuReceipt）：过滤镜像路径，字段白名单，长度截断。
// 上限写在 docs/plugin-api.md「故事视图契约」。
const TAVERN_STORY_RECEIPT_LIMITS = Object.freeze({ value: 120, path: 200, operation: 20, text: 500, items: 50, diagnostics: 3 });
const TAVERN_STORY_RECEIPT_STATUSES = ["pending", "updated", "partial", "error", "stale", "interrupted", "unchanged"];
// MVU display/delta 镜像与 schema 维护留在回执里供诊断，不是玩家关心的变化。
const TAVERN_STORY_RECEIPT_MIRROR = /^\/(?:delta_data|display_data|schema)(?:\/|$)/;
function tavernStoryClip(value, limit) {
	const text = String(value);
	return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
}
// before/after 只给展示字符串：短值原样；过长的对象、数组给摘要，其余截断。
function tavernStoryReceiptValue(value) {
	const limit = TAVERN_STORY_RECEIPT_LIMITS.value;
	if (value === undefined) return "（不存在）";
	let parsed = value;
	if (typeof value === "string") {
		if (value.length <= limit) return value;
		if (!/^\s*[[{]/.test(value)) return tavernStoryClip(value, limit);
		try { parsed = JSON.parse(value); } catch (_error) { return tavernStoryClip(value, limit); }
	} else if (value === null || typeof value !== "object") return tavernStoryClip(String(value), limit);
	else {
		const json = JSON.stringify(value);
		if (json.length <= limit) return json;
	}
	if (Array.isArray(parsed)) return "[" + parsed.length + " 项]";
	if (parsed === null || typeof parsed !== "object") return tavernStoryClip(String(value), limit);
	const keys = Object.keys(parsed);
	return tavernStoryClip("{" + keys.slice(0, 5).join(", ") + (keys.length > 5 ? ", …" : "") + "}（" + keys.length + " 项）", limit);
}
function tavernStoryReceiptChange(change) {
	return Object.freeze({
		path: tavernStoryClip(change && change.path || "/", TAVERN_STORY_RECEIPT_LIMITS.path),
		operation: tavernStoryClip(change && change.operation || "", TAVERN_STORY_RECEIPT_LIMITS.operation),
		before: tavernStoryReceiptValue(change && change.before),
		after: tavernStoryReceiptValue(change && change.after)
	});
}
function tavernStoryReceiptChanges(list) {
	return (Array.isArray(list) ? list : []).filter(function (change) { return !TAVERN_STORY_RECEIPT_MIRROR.test(String(change && change.path || "")); });
}
const tavernStoryReceiptCache = new WeakMap();
function tavernStoryReceipt(receipt) {
	if (!receipt || typeof receipt !== "object") return null;
	const known = tavernStoryReceiptCache.get(receipt);
	if (known) return known;
	const limits = TAVERN_STORY_RECEIPT_LIMITS;
	const status = TAVERN_STORY_RECEIPT_STATUSES.includes(receipt.status) ? receipt.status : "unchanged";
	const changes = tavernStoryReceiptChanges(receipt.changes), sideEffects = tavernStoryReceiptChanges(receipt.sideEffects);
	const failures = Array.isArray(receipt.failures) ? receipt.failures : [];
	const diagnostics = (status === "error" || status === "partial") && Array.isArray(receipt.runtimeDiagnostics)
		? receipt.runtimeDiagnostics.filter(function (item) { return item && item.message && ["warn", "error"].includes(item.level); }).slice(-limits.diagnostics)
			.map(function (item) { return tavernStoryClip(item.message, limits.text); })
		: [];
	const projected = Object.freeze({
		status: status,
		changes: Object.freeze(changes.slice(0, limits.items).map(tavernStoryReceiptChange)),
		sideEffects: Object.freeze(sideEffects.slice(0, limits.items).map(tavernStoryReceiptChange)),
		failures: Object.freeze(failures.slice(0, limits.items).map(function (failure) {
			return Object.freeze({
				path: tavernStoryClip(failure && (failure.path || failure.command) || "", limits.path),
				operation: tavernStoryClip(failure && failure.operation || "", limits.operation),
				message: tavernStoryClip(failure && failure.message || "未知错误", limits.text)
			});
		})),
		summary: tavernStoryClip(receipt.summary || "", limits.text),
		diagnostics: Object.freeze(diagnostics),
		counts: Object.freeze({ changes: changes.length, sideEffects: sideEffects.length, failures: failures.length })
	});
	tavernStoryReceiptCache.set(receipt, projected);
	return projected;
}
// 本窗口各楼层的回执，按故事轮号（= floor.story，也是视图 mvuReceipts 的 turn）。
function tavernStoryReceipts(view, floors) {
	const receipts = {};
	if (view) for (const floor of floors) {
		const receipt = tavernStoryReceipt(tavernMvuReceiptForTurn(view, floor.story));
		if (receipt) receipts[floor.story] = receipt;
	}
	return Object.freeze(receipts);
}
// The player input a failed or stopped round dropped, while it is still the latest thing
// the player did: no later floor, no newer input, nothing running.
function tavernStoryInterruptedInput(rounds) {
	if (!rounds || rounds.open) return null;
	const input = rounds.abandoned[rounds.abandoned.length - 1];
	if (!input || !TAVERN_STORY_FAILED_ENDS.includes(input.reason)) return null;
	const last = rounds.floors[rounds.floors.length - 1];
	if (last && Math.max(last.reply.seq, ...last.inputs.map(item => item.seq)) > input.seq) return null;
	return Object.freeze({ seq: input.seq, turn: input.turn, text: input.text, reason: input.reason });
}

function createTavernStoryService(options) {
	const sessions = options.sessions;
	const actions = options.actions;
	const flow = actions.interactions;
	function eventSourceOf(sessionId) {
		const binding = sessions && typeof sessions.binding === "function" ? sessions.binding(sessionId) : undefined;
		if (!binding || !binding.eventSource) throw new Error("这一局没有在当前页面打开");
		return binding.eventSource;
	}
	function foldNow(sessionId) {
		const rounds = foldStoryRounds(tavernStoryEvents(eventSourceOf(sessionId).getSnapshot().entries));
		return Object.freeze(Object.assign({}, rounds, { interrupted: tavernStoryInterruptedInput(rounds) }));
	}
	// The Tavern view of the game (the dock reads the same one), loaded once if nothing holds it yet.
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
	function afterChange(sessionId) {
		notifyTavernDataChanged(["sessions"], "story-service");
		liveTavernView.invalidate(sessionId);
		tavernCoordination.invalidate(sessionId);
	}
	function clearPanels() {
		flow.candidates.set(null); flow.regeneration.set(null); flow.guide.set(null);
	}
	// Same steps as the dock's 「回退本轮」 (TavernRollbackAction).
	async function rollbackOnce(sessionId, expectedTurn) {
		try {
			const result = await rpc("rollbackTurn", { expectedTurn: expectedTurn }, sessionId) || {};
			actions.historyProjection.rolledBack(sessionId, result.view);
			clearPanels();
			return result;
		} finally { afterChange(sessionId); }
	}
	// regenBody always rewrites the latest floor: check it is the one asked for, on the live
	// event window (current) and on the Tavern view (whether this floor may be regenerated).
	async function latestFloor(sessionId, storyTurn, label) {
		const rounds = foldNow(sessionId), latest = rounds.floors[rounds.floors.length - 1];
		if (rounds.open) throw new Error("正在生成，请完成或停止后再" + label);
		if (!latest || latest.story !== storyTurn) throw new Error(label + "只能用于最新楼层（当前第 " + (latest ? latest.story : 0) + " 轮）");
		const view = await viewOf(sessionId);
		if (tavernStorySettling(view)) throw new Error(TAVERN_STORY_SETTLING_ERROR);
		if (!isPlayMode(view.mode) || view.canRegenerate !== true) throw new Error("这一层不能" + label);
		return view;
	}
	// The dock's body regeneration flow, so guidance memory and the in-flight guard are shared.
	async function regenerateBody(sessionId, guidance, extra) {
		const panel = flow.regeneration.set({ sessionId: sessionId, phase: "input", guidance: "", text: "", error: "", tail: null });
		flow.candidates.set(null);
		await flow.regenerateBody(panel, guidance, extra || {});
		const after = flow.regeneration.getSnapshot();
		if (after && after.sessionId === sessionId && (after === panel || after.phase === "error")) {
			flow.regeneration.set(null);
			throw new Error(after === panel ? "正文正在重新生成，请等待完成" : after.error);
		}
		afterChange(sessionId);
		return { view: liveTavernView.getSnapshot(sessionId).view };
	}

	const service = {
		apiVersion: 1,
		/** Floor rendering runtime (contract C7, features/story-render.js). */
		render: options.render || null,
		/** Whether Tavern leaves the chat rows to the host (contract C4). */
		storyViewMode: function () { return tavernStoryViewMode.enabled(); },
		setStoryViewMode: function (value) { return tavernStoryViewMode.set(value); },
		subscribeStoryViewMode: function (listener) {
			if (typeof listener !== "function") throw new TypeError("subscribeStoryViewMode 需要 listener 函数");
			return tavernStoryViewMode.subscribe(function () { listener(tavernStoryViewMode.enabled()); });
		},
		/**
		 * Floors folded from this page's event window (C1), now and after every change.
		 * listener({ floors, abandoned, open, attempt, interrupted, settling, staleVariables, receipts, settlement, hasMore, from }); returns unsubscribe.
		 * `open.liveText` is the running round's streamed reply text so far (plain text, throttled);
		 * `settling` is true while the latest floor's background settlement is pending or running;
		 * `staleVariables` is { turn, replySeq } while an MVU card's latest floor shows a switched
		 * result its variables were not settled for (saved; cleared once resettle succeeds), else null.
		 * `receipts` maps a loaded floor's story turn to its MVU receipt (display projection of the
		 * view's mvuReceipts); `settlement` is { status: 'running' | 'error' | 'idle', turn, error }
		 * of the latest floor's background settlement, null until the Tavern view is read.
		 */
		subscribeRounds: function (sessionId, listener) {
			tavernStorySessionArgument(sessionId, "subscribeRounds");
			if (typeof listener !== "function") throw new TypeError("subscribeRounds 需要 listener 函数");
			const source = eventSourceOf(sessionId);
			let fold = null, live = null, revision = -1, published = null, publishedLive = "", hasMore = null, stopped = false, timer = null, settling = false, staleVariables = null;
			let view = null, settlement = null;
			function liveTextOf(rounds) { return rounds.open && live && live.turn === rounds.open.turn ? live.text : ""; }
			function emit() {
				if (timer !== null) { window.clearTimeout(timer); timer = null; }
				if (stopped) return;
				const snapshot = source.getSnapshot(), rounds = fold.result();
				published = rounds; hasMore = snapshot.hasMore; publishedLive = liveTextOf(rounds);
				const open = rounds.open ? Object.freeze(Object.assign({}, rounds.open, { liveText: publishedLive })) : null;
				const first = snapshot.entries.find(function (entry) { return entry && entry.type === "event"; });
				listener(Object.freeze(Object.assign({}, rounds, { open: open, interrupted: tavernStoryInterruptedInput(rounds), settling: settling, staleVariables: staleVariables,
					receipts: tavernStoryReceipts(view, rounds.floors), settlement: settlement, hasMore: snapshot.hasMore, from: first ? first.event.seq : null })));
			}
			function publish() {
				if (stopped) return;
				const snapshot = source.getSnapshot();
				if (snapshot.revision === revision) return;
				// Live appends extend the fold; a prepend, rebaseline or settlement folds the window again.
				if (fold && snapshot.change && snapshot.change.kind === "append" && snapshot.revision === revision + 1) {
					fold.addEvents(tavernStoryEvents(snapshot.change.entries));
					for (const entry of snapshot.change.entries) live = tavernStoryLiveChunk(live, entry);
				} else {
					fold = createStoryRoundsFold(); fold.addEvents(tavernStoryEvents(snapshot.entries));
					live = tavernStoryLiveOf(snapshot.entries);
				}
				revision = snapshot.revision;
				if (fold.result() !== published || snapshot.hasMore !== hasMore) return emit();
				// Streaming chunks change no floor: only the preview text, at most every 100 ms.
				if (liveTextOf(published) !== publishedLive && timer === null) timer = window.setTimeout(emit, TAVERN_STORY_LIVE_TEXT_MS);
			}
			// Settlement state, receipts and the stale-variables mark live in the Tavern view, not in the event window.
			function readView(state) {
				const next = state && state.view || null;
				const nextSettling = tavernStorySettling(next);
				const stale = next && next.staleVariables ? Object.freeze({ turn: next.staleVariables.turn, replySeq: next.staleVariables.replySeq }) : null;
				const nextSettlement = tavernStorySettlement(next);
				const changed = nextSettling !== settling || JSON.stringify(stale) !== JSON.stringify(staleVariables)
					|| JSON.stringify(nextSettlement) !== JSON.stringify(settlement) || (next && next.mvuReceipts) !== (view && view.mvuReceipts);
				view = next;
				if (!changed) return false;
				settling = nextSettling; staleVariables = stale; settlement = nextSettlement;
				return true;
			}
			readView(liveTavernView.getSnapshot(sessionId));
			const stopView = liveTavernView.subscribe(sessionId, function (state) {
				if (readView(state) && fold) emit();
			}, [["activity"], ["staleVariables"], ["mvuReceipts"], ["settleStatus"], ["settlementTurn"], ["settleError"]]);
			const unsubscribe = source.subscribe(publish);
			publish();
			return function () { stopped = true; if (timer !== null) window.clearTimeout(timer); unsubscribe(); stopView(); };
		},
		/** Every reply the floor has had, oldest first; `current` marks the one shown. */
		listResults: function (sessionId, storyTurn) {
			const turn = tavernStoryTurnArgument(storyTurn, "listResults");
			const floor = foldNow(tavernStorySessionArgument(sessionId, "listResults")).floors.find(function (item) { return item.story === turn; });
			return floor ? floor.history : null;
		},
		/**
		 * Show an earlier generation of the latest floor again (`replySeq` from listResults).
		 * Returns { switched, turn, replySeq, mvu: 'stale' | 'unchanged', view }; 'stale' means
		 * the variables still follow the reply shown before and want a settlement retry.
		 */
		switchResult: async function (sessionId, storyTurn, replySeq) {
			tavernStorySessionArgument(sessionId, "switchResult");
			const turn = tavernStoryTurnArgument(storyTurn, "switchResult");
			const seq = Number(replySeq);
			if (!Number.isSafeInteger(seq) || seq < 0) throw new TypeError("switchResult 需要 listResults 给出的 replySeq");
			const before = await latestFloor(sessionId, turn, "切换历史结果");
			try {
				const result = await rpc("switchFloorResult", { turn: turn, replySeq: seq }, sessionId);
				clearPanels();
				const mvu = result && result.mvu;
				// Only an MVU card's variables can be settled again for the shown reply (resettle).
				const officialMvu = Boolean(before.tavernMvuRuntime && before.tavernMvuRuntime.owner === "official");
				return { switched: result && result.switched === true, turn: result && result.turn, replySeq: result && result.replySeq, mvu: mvu, resettle: mvu === "stale" && officialMvu, view: result && result.view };
			} finally { afterChange(sessionId); }
		},
		/**
		 * Start a new game from this floor's current reply (any settled floor, the opening
		 * included); later floors stay behind. Same flow as the chat's fork button (the sidebar
		 * forks the native session, binds the save, names and opens the new game), through the
		 * floor RPCs. Resolves once the new game is open: { sessionId, chatId, turn, replySeq }.
		 */
		forkAt: async function (sessionId, storyTurn) {
			tavernStorySessionArgument(sessionId, "forkAt");
			const turn = tavernStoryTurnArgument(storyTurn, "forkAt");
			const rounds = foldNow(sessionId);
			const attempting = rounds.attempt && (rounds.attempt.phase === "preparing" || rounds.attempt.phase === "generating");
			if (rounds.open || attempting) throw new Error("正在生成，请完成或停止后再创建分支");
			if (tavernStorySettling(liveTavernView.getSnapshot(sessionId).view)) throw new Error(TAVERN_STORY_SETTLING_ERROR);
			if (!rounds.floors.some(function (floor) { return floor.story === turn; })) throw new Error("第 " + turn + " 轮不是当前已加载的楼层");
			return tavernConversationForkRequests.request({ sessionId: sessionId, turn: turn, floor: true });
		},
		/** 打断指定原生回合，并重新投递队尾那条排队输入，让它接着成为下一轮。 */
		interruptQueued: function (sessionId, turn) {
			return rpc("interruptStoryQueue", { turn: tavernStoryTurnArgument(turn, "interruptQueued") }, tavernStorySessionArgument(sessionId, "interruptQueued"));
		},
		/**
		 * Remove this floor and every later one (latest first), clearing a failed tail on the way.
		 * `input` is the removed floor's own player input ({ text }), for the composer; null
		 * when the floor is outside the loaded window or has none (the opening).
		 */
		rollbackTo: async function (sessionId, storyTurn) {
			tavernStorySessionArgument(sessionId, "rollbackTo");
			const turn = tavernStoryTurnArgument(storyTurn, "rollbackTo");
			let view = await viewOf(sessionId);
			if (turn > (Number(view.rollbackTargetTurn) || 0)) throw new Error("第 " + turn + " 轮不是现有楼层");
			const binding = sessions && typeof sessions.binding === "function" ? sessions.binding(sessionId) : undefined;
			const floor = binding && binding.eventSource ? foldNow(sessionId).floors.find(function (item) { return item.story === turn; }) : null;
			const input = floor && floor.inputs.length ? { text: floor.inputs.map(function (item) { return item.text; }).join("\n") } : null;
			const rolledBack = [];
			let clearedInput = null;
			for (let step = 0; ; step++) {
				const clearing = view.canClearIncompleteReply === true;
				const target = Number(view.rollbackTargetTurn) || 0;
				if (!clearing && target < turn) break;
				if (step >= TAVERN_STORY_MAX_ROLLBACK_STEPS) throw new Error("一次最多回退 " + TAVERN_STORY_MAX_ROLLBACK_STEPS + " 层");
				// A failed tail is cleared first (its input comes back); the next call removes a floor.
				const result = await rollbackOnce(sessionId, clearing ? null : target);
				const next = result.view || {};
				if (clearing) { if (typeof next.clearedInput === "string") clearedInput = next.clearedInput; }
				else rolledBack.push(target);
				if (!clearing && (Number(next.rollbackTargetTurn) || 0) >= target && next.canClearIncompleteReply !== true) throw new Error("第 " + target + " 轮回退后仍是最新楼层");
				if (clearing && next.canClearIncompleteReply === true) throw new Error("未能清除失败的回合");
				view = next;
				if (next.rollbackWarning) tavernErrorHub.report("回退提示", new Error(next.rollbackWarning));
			}
			return { view: view, rolledBack: rolledBack, clearedInput: clearedInput, input: input };
		},
		/** Resample the latest floor without guidance (the dock's 重新生成正文 with an empty box). */
		regenerate: async function (sessionId, storyTurn) {
			tavernStorySessionArgument(sessionId, "regenerate");
			await latestFloor(sessionId, tavernStoryTurnArgument(storyTurn, "regenerate"), "重新生成");
			return regenerateBody(sessionId, "");
		},
		/** Rewrite the latest floor with guidance; it becomes the game's remembered guidance. */
		regenerateWithGuidance: async function (sessionId, storyTurn, guidance, extra) {
			tavernStorySessionArgument(sessionId, "regenerateWithGuidance");
			if (typeof guidance !== "string" || guidance.trim() === "") throw new TypeError("regenerateWithGuidance 需要非空 guidance");
			await latestFloor(sessionId, tavernStoryTurnArgument(storyTurn, "regenerateWithGuidance"), "按要求改写");
			return regenerateBody(sessionId, guidance, extra && extra.restyle === true ? { restyle: true, styleGuidance: String(extra.styleGuidance || "") } : {});
		},
		/**
		 * Edit the latest floor's prose (the dock's 编辑正文 panel: getBodyEdit / saveBodyEdit).
		 * get → { token, turn, parts: [{ kind: 'text', text } | { kind: 'html' | 'marker' }] };
		 * save(sessionId, storyTurn, { token, texts }) with one string per text part, HTML kept.
		 * The model sees the edited text from the next round on; variables are not settled again.
		 */
		editReply: {
			get: async function (sessionId, storyTurn) {
				tavernStorySessionArgument(sessionId, "editReply.get");
				const turn = tavernStoryTurnArgument(storyTurn, "editReply.get");
				await latestFloor(sessionId, turn, "编辑正文");
				const result = await rpc("getBodyEdit", {}, sessionId);
				const edit = result && result.edit;
				if (!edit || Number(edit.turn) !== turn) throw new Error("最新正文已变化，请刷新后再编辑");
				return { token: edit.token, turn: turn, parts: edit.parts };
			},
			save: async function (sessionId, storyTurn, edit) {
				tavernStorySessionArgument(sessionId, "editReply.save");
				const turn = tavernStoryTurnArgument(storyTurn, "editReply.save");
				if (!edit || typeof edit.token !== "string" || !Array.isArray(edit.texts) || edit.texts.some(function (text) { return typeof text !== "string"; })) throw new TypeError("editReply.save 需要 get 给出的 token 与 texts 字符串数组");
				await latestFloor(sessionId, turn, "编辑正文");
				try {
					const result = await rpc("saveBodyEdit", { token: edit.token, turn: turn, texts: edit.texts }, sessionId);
					clearPanels();
					return { view: result && result.view };
				} finally { afterChange(sessionId); }
			}
		},
		/**
		 * Change the player input of the latest floor (getBodyEdit / saveBodyEdit with role
		 * 'user': a replacement on the model surface and the save's text). The reply stays;
		 * call regenerate afterwards for a reply to the new input — it reads the saved text.
		 */
		editInput: async function (sessionId, storyTurn, text) {
			tavernStorySessionArgument(sessionId, "editInput");
			const turn = tavernStoryTurnArgument(storyTurn, "editInput");
			if (typeof text !== "string" || text.trim() === "") throw new TypeError("editInput 需要非空输入文字");
			await latestFloor(sessionId, turn, "修改输入");
			const floor = foldNow(sessionId).floors.find(function (item) { return item.story === turn; });
			const input = floor && floor.inputs[floor.inputs.length - 1];
			if (!input) throw new Error("这一层没有玩家输入");
			try {
				const read = await rpc("getBodyEdit", { role: "user", turn: input.turn, seq: input.seq }, sessionId);
				const edit = read && read.edit;
				if (!edit || edit.role !== "user") throw new Error("读取这条输入失败");
				const result = await rpc("saveBodyEdit", { token: edit.token, role: "user", index: edit.index, turn: edit.turn, seq: edit.seq, texts: [text] }, sessionId);
				clearPanels();
				return { view: result && result.view };
			} finally { afterChange(sessionId); }
		},
		/**
		 * Settle the latest floor again for the reply it now shows (retrySettlement), e.g. after
		 * switchResult reported mvu 'stale'. Latest floor only; the server decides whether this
		 * card has a settlement to redo. `options.guidance` (optional, ≤ 4000 characters) applies to
		 * this settlement only; omitted, the server reuses the last guidance. Resolves once the
		 * settlement is queued: { view }.
		 */
		resettle: async function (sessionId, storyTurn, options) {
			tavernStorySessionArgument(sessionId, "resettle");
			const turn = tavernStoryTurnArgument(storyTurn, "resettle");
			const guidance = options === undefined || options === null ? undefined : options.guidance;
			if (options !== undefined && options !== null && typeof options !== "object") throw new TypeError("resettle 的第三个参数需要 { guidance? }");
			if (guidance !== undefined && (typeof guidance !== "string" || guidance.length > TAVERN_STORY_GUIDANCE_MAX)) throw new TypeError("resettle 的 guidance 需要不超过 " + TAVERN_STORY_GUIDANCE_MAX + " 字的字符串");
			await latestFloor(sessionId, turn, "重新结算");
			try {
				const result = await rpc("retrySettlement", guidance === undefined ? { turn: turn } : { turn: turn, guidance: guidance }, sessionId);
				if (result && result.view) liveTavernView.setView(sessionId, result.view);
				return { view: result && result.view };
			} finally { afterChange(sessionId); }
		},
		/** The guidance last used for this game (offered again when rewriting once more). */
		guidance: function (sessionId) { return flow.guidance(tavernStorySessionArgument(sessionId, "guidance")); },
		/** Replay a failed or stopped latest round with its original input. */
		retryFailed: async function (sessionId) {
			tavernStorySessionArgument(sessionId, "retryFailed");
			const result = await actions.replayFailedTurn(sessionId);
			return { view: result && result.view };
		},
		/** The input a failed or stopped round dropped, while the player has not moved on; or null. */
		readInterruptedInput: function (sessionId) {
			return foldNow(tavernStorySessionArgument(sessionId, "readInterruptedInput")).interrupted;
		},
		/** Store a floor's static HTML (contract C3); `floor` is a floor from subscribeRounds. */
		writeFloorSnapshot: async function (sessionId, floor, snapshot) {
			tavernStorySessionArgument(sessionId, "writeFloorSnapshot");
			const turn = tavernStoryTurnArgument(floor && floor.story, "writeFloorSnapshot");
			if (!floor.reply || !Number.isSafeInteger(Number(floor.reply.seq))) throw new TypeError("writeFloorSnapshot 需要带 reply.seq 的楼层");
			if (!snapshot || typeof snapshot.html !== "string") throw new TypeError("writeFloorSnapshot 需要 html 字符串");
			return rpc("saveFloorSnapshot", { turn: turn, reply: String(floor.reply.seq), html: snapshot.html, truncated: snapshot.truncated === true }, sessionId);
		},
		/** Stored snapshots of these floors, by story turn; one taken of another reply is left out. */
		readFloorSnapshots: async function (sessionId, floors) {
			tavernStorySessionArgument(sessionId, "readFloorSnapshots");
			const wanted = (Array.isArray(floors) ? floors : []).filter(function (floor) { return floor && floor.reply && Number.isSafeInteger(Number(floor.story)) && floor.story > 0; });
			if (!wanted.length) return {};
			const result = await rpc("getFloorSnapshots", { turns: wanted.map(function (floor) { return floor.story; }) }, sessionId);
			const stored = result && result.snapshots || {}, snapshots = {};
			for (const floor of wanted) {
				const snapshot = stored[floor.story];
				if (snapshot && snapshot.reply === String(floor.reply.seq)) snapshots[floor.story] = snapshot;
			}
			return snapshots;
		},
		readFloorSnapshot: async function (sessionId, floor) {
			const snapshots = await service.readFloorSnapshots(sessionId, [floor]);
			return floor && snapshots[floor.story] || null;
		}
	};
	return service;
}
