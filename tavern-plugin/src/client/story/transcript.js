// v2 桥只包装上游逻辑历史；每局独立 store，原生事件仅补运行状态和旧结果。
function createStoryTranscriptAdapter({ createTavernStoryTranscriptDataModule, tavernProjectionForTurn }) {
	const data = createTavernStoryTranscriptDataModule();
	const sessions = new Map();
	function entry(sessionId) {
		if (!sessions.has(sessionId)) sessions.set(sessionId, { store: data.createStoryTranscriptStore(), from: undefined, pending: null, dirty: false, cached: null });
		return sessions.get(sessionId);
	}
	function bodyKey(uid, text) {
		// 可重建缓存的版本指纹；身份始终由服务端 UID 提供。
		let hash = 2166136261;
		for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
		return uid + ':' + (hash >>> 0).toString(36) + ':' + text.length;
	}
	function floors(sessionId, nativeRounds) {
		const item = entry(sessionId), state = item.store.getSnapshot();
		const transcript = state.transcript;
		if (item.cached?.transcript === transcript && item.cached?.view === state.view && item.cached?.native === nativeRounds?.floors) {
			return { ...item.cached.value, view: state.view, error: state.error?.message || '' };
		}
		const rows = data.storyTranscriptRows(transcript);
		const counts = new Map();
		for (const row of rows) if (row.role === 'assistant') counts.set(row.legacyTurn, (counts.get(row.legacyTurn) || 0) + 1);
		let inputs = [];
		const result = [];
		for (const row of rows) {
			const target = Object.freeze({ messageUid: row.messageUid, messageIndex: row.absoluteIndex, revision: transcript.revision });
			if (row.role === 'user') {
				// 每个持久 RPC 输入独占一次生成；连续两个输入之间没有正文时，前一次已失败或被替换。
				// 未带 RPC 身份的导入多条输入继续按原顺序保留。
				const requestId = row.message.source?.rpcId;
				if (requestId) inputs = inputs.filter(input => !input.requestId || input.requestId === requestId);
				const display = row.message.tavernPluginData?.template_display;
				const templateHtml = display && display.source === (row.message.sourceText ?? row.message.text) && display.swipe === (row.message.swipeId || 0) ? display.html : null;
				inputs.push(Object.freeze({ ...target, target, seq: row.messageUid, turn: row.legacyTurn, text: row.text, templateHtml, requestId }));
			}
			if (row.role !== 'assistant' || row.streaming) continue;
			const native = counts.get(row.legacyTurn) === 1 && (nativeRounds?.floors || []).find(item => item.story === row.legacyTurn && item.reply.text === (row.message.sourceText ?? row.message.text ?? row.text));
			const history = Array.isArray(row.message.storyResults) ? row.message.storyResults.map(item => ({ ...item, seq: item.id, current: item.id === row.message.storyResultId })) : native?.history || [];
			result.push(Object.freeze({
				story: row.floorNo, messageUid: row.messageUid, legacyTurn: row.legacyTurn, target,
				projection: (!row.streaming && counts.get(row.legacyTurn) === 1 && tavernProjectionForTurn(state.view, row.legacyTurn)) || row.projection, streaming: row.streaming, greeting: row.greeting,
				inputs: Object.freeze(inputs), history: Object.freeze(history),
				reply: Object.freeze({ seq: bodyKey(row.messageUid, row.text), turn: row.legacyTurn, text: row.text,
					incomplete: row.message.incomplete === true, incompleteReason: row.message.incompleteReason || '' })
			}));
			inputs = [];
		}
		const value = { floors: Object.freeze(result), from: transcript?.from ?? null, hasMore: (transcript?.from || 0) > 0,
			view: state.view, error: state.error?.message || '', revision: transcript?.revision ?? null };
		item.cached = { transcript, view: state.view, native: nativeRounds?.floors, value };
		return value;
	}
	function read(sessionId, force) {
		const item = entry(sessionId);
		if (item.pending) { if (force) item.dirty = true; return item.pending; }
		item.pending = (async function () {
			let result;
			do {
				item.dirty = false;
				result = await item.store.read(sessionId, { historyFrom: item.from, force: force === true });
				force = true;
			} while (item.dirty);
			return result;
		})().finally(function () { item.pending = null; });
		return item.pending;
	}
	async function older(sessionId) {
		const item = entry(sessionId), from = item.store.getSnapshot().transcript?.from;
		if (!(from > 0)) return false;
		item.from = Math.max(0, from - 120);
		await read(sessionId);
		return true;
	}
	return { floors, read, older, subscribe(sessionId, listener) { return entry(sessionId).store.subscribe(listener); },
		resolve(sessionId, target, nativeRounds) {
			if (!target || typeof target.messageUid !== 'string') throw new TypeError('操作需要逻辑消息身份，请刷新故事页');
			const floor = floors(sessionId, nativeRounds).floors.find(item => item.messageUid === target.messageUid);
			if (!floor) throw new Error('这条消息已经变化，请刷新故事页');
			return floor;
		} };
}

export { createStoryTranscriptAdapter };
