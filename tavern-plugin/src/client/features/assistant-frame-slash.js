        function tavernStoryInputChanged(hostWindow, sessionId) {
            if (typeof hostWindow.dispatchEvent === "function" && typeof hostWindow.CustomEvent === "function") {
                hostWindow.dispatchEvent(new hostWindow.CustomEvent("dsh-tavern-story-mutated", { detail: { sessionId: sessionId } }));
            }
        }
        async function persistTavernPlayerInput(hostWindow, sessionId, text, requestId) {
            const saved = await rpc("appendPlayerInput", { sessionId: sessionId, requestId: requestId, text: text }, sessionId);
            if (saved?.saved === true) tavernStoryInputChanged(hostWindow, sessionId);
            return saved;
        }
        // The host's visible composer owns its own submit pipeline. Observe its
        // existing request id and persist that player row independently of prompt/LLM.
        function installTavernPlayerInputPersistence(ctx, hostWindow) {
            hostWindow = hostWindow || window;
            if (typeof ctx?.sessions?.binding !== "function" || typeof ctx?.sessions?.list?.subscribe !== "function") return function () {};
            const originals = new Map();
            function install(sessionId) {
                const session = ctx.sessions.binding(sessionId)?.session;
                if (!session || originals.has(session) || typeof session.beginSubmission !== "function") return;
                const begin = session.beginSubmission;
                function wrapped(input) {
                    const handle = begin.call(session, input);
                    const text = typeof input?.text === "string" ? input.text.trim() : "";
                    if (handle?.requestId && text) Promise.resolve()
                        .then(function () { return persistTavernPlayerInput(hostWindow, sessionId, text, handle.requestId); })
                        .catch(function (error) {
                            if (typeof tavernErrorHub !== "undefined") tavernErrorHub.report("保存玩家输入", error);
                            else console.warn("dsh-tavern: 保存玩家输入失败", error);
                        });
                    return handle;
                }
                originals.set(session, { begin: begin, wrapped: wrapped });
                session.beginSubmission = wrapped;
            }
            function sync() {
                const snapshot = ctx.sessions.list.getSnapshot();
                for (const sessionId of Object.keys(snapshot?.byId || {})) install(sessionId);
            }
            const stop = ctx.sessions.list.subscribe(sync);
            sync();
            return function () {
                stop();
                for (const [session, record] of originals) if (session.beginSubmission === record.wrapped) session.beginSubmission = record.begin;
                originals.clear();
            };
        }
		function createTavernFrameSlashExecutor(ctx, hostWindow) {
			hostWindow = hostWindow || window;
            // A deliberately bounded, read-only subset of ST slash commands. Parse
            // every stage before reading anything; never forward a mixed pipeline.
            function slashError(message) {
                return Object.assign(new Error(message), { code: "UNSUPPORTED_SLASH_PIPELINE" });
            }
            function decodeSlashText(value) {
                value = value.trim();
                if ((value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) value = value.slice(1, -1);
                return value.replace(/\\([\\|"'])/g, '$1');
            }
            function readPipeline(line) {
                const stages = [];
                let start = 0, quote = '', escaped = false;
                for (let i = 0; i < line.length; i++) {
                    const ch = line[i];
                    if (escaped) { escaped = false; continue; }
                    if (ch === '\\') { escaped = true; continue; }
                    if (quote) { if (ch === quote) quote = ''; continue; }
                    if ((ch === '"' || ch === "'") && (i === start || /[\s=]/.test(line[i - 1]))) { quote = ch; continue; }
                    if (ch === '|') { stages.push(line.slice(start, i).trim()); start = i + 1; }
                }
                if (quote) throw slashError('人物卡命令引号未闭合');
                stages.push(line.slice(start).trim());
                return stages.map(function (stage) {
                    const match = /^\/(pass|return|findentry|findlore|findwi)(?:\s+([\s\S]*))?$/i.exec(stage);
                    if (!match) throw slashError('暂不支持这条人物卡命令管道；/pass 和 /findentry 只能与只读命令组合，未发送消息');
                    const command = match[1].toLowerCase();
                    let text = match[2] || '';
                    if (command === 'pass' || command === 'return') return { command: 'pass', text: decodeSlashText(text) };
                    const args = {};
                    while (true) {
                        const named = /^([a-zA-Z_]\w*)=/.exec(text);
                        if (!named) break;
                        const key = named[1];
                        if (!['file', 'field'].includes(key) || Object.hasOwn(args, key)) throw slashError('不支持或重复的 /findentry 参数: ' + key);
                        text = text.slice(named[0].length);
                        let end = 0;
                        if (text[0] === '"' || text[0] === "'") {
                            const quote = text[0]; end = 1;
                            for (; end < text.length; end++) {
                                if (text[end] === '\\') { end++; continue; }
                                if (text[end] === quote) { end++; break; }
                            }
                            if (end < text.length && !/\s/.test(text[end])) throw slashError('/findentry 引号后需要空格');
                        } else {
                            while (end < text.length && !/\s/.test(text[end])) end++;
                        }
                        args[key] = decodeSlashText(text.slice(0, end));
                        text = text.slice(end).trimStart();
                    }
                    const field = args.field || 'key';
                    if (!args.file) throw slashError('/findentry 需要 file=当前世界书名称（或 current）');
                    if (!['key', 'keysecondary', 'comment', 'name', 'content', 'uid'].includes(field)) throw slashError('暂不支持 /findentry 字段: ' + field);
                    return { command: 'findentry', file: args.file, field: field, text: decodeSlashText(text) };
                });
            }
            async function executeReadPipeline(line, sessionId) {
                const stages = readPipeline(line);
                let pipe = '';
                for (const stage of stages) {
                    const text = stage.text.replace(/\{\{pipe\}\}/gi, function () { return pipe; });
                    if (stage.command === 'pass') { pipe = text; continue; }
                    const file = stage.file.replace(/\{\{pipe\}\}/gi, function () { return pipe; });
                    const result = await rpc('getTavernHelperWorldbook', { name: file }, sessionId);
                    const query = text.toLowerCase();
                    let found = null, best = Infinity;
                    for (const entry of result?.worldbook?.entries || []) {
                        const field = stage.field;
                        const value = field === 'key' ? entry.strategy?.keys : field === 'keysecondary' ? entry.strategy?.keys_secondary?.keys
                            : field === 'comment' ? entry.name : entry[field];
                        for (const item of Array.isArray(value) ? value : [value]) {
                            if (item === undefined || item === null || !query) continue;
                            const candidate = String(item).toLowerCase();
                            const position = candidate.indexOf(query);
                            // Exact matches outrank substrings. Stable ties retain book order.
                            const score = candidate === query ? 0 : position < 0 ? Infinity : 1 + position + (candidate.length - query.length) / (candidate.length + 1);
                            if (score < best) { best = score; found = entry; }
                        }
                    }
                    pipe = found?.uid === undefined ? '' : String(found.uid);
                }
                return pipe;
            }
			function inputFacade(sessionId) {
				const actx = ctx.sessions.scope(sessionId);
				const conversation = ctx.get("conversation");
				if (!actx || !conversation) return null;
				try { return conversation.input.for(actx); } catch (_) { return null; }
			}
			function readInputDraft(sessionId) {
				const input = inputFacade(sessionId);
				if (!input) return "";
				try {
					const state = input.state && typeof input.state.getSnapshot === "function" ? input.state.getSnapshot() : null;
					if (state && typeof state.draft === "string") return state.draft;
				} catch (_) {}
				return "";
			}
            function createSubmissionRequestId() {
                return hostWindow.crypto?.randomUUID?.() || "tavern-input-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
            }
            function storyChanged(sessionId) { tavernStoryInputChanged(hostWindow, sessionId); }
            function persistPlayerInput(sessionId, text, requestId) {
                return persistTavernPlayerInput(hostWindow, sessionId, text, requestId);
            }
			const pendingSend = new Map();
            const submitting = new Set();
			const execute = function (line, sessionId, options) {
                if (options && typeof options.inputText === "string") {
                    const text = options.inputText.trim();
                    const binding = ctx.sessions.binding(sessionId);
                    if (!text || !binding) return Promise.reject(new Error("开局消息为空或原对话已关闭"));
                    const requestId = createSubmissionRequestId();
                    return persistPlayerInput(sessionId, text, requestId)
                        .then(function () { return binding.session.prompt([{ type:"text", text:text }], "queue", undefined, requestId); })
                        .then(function (result) {
                            if (!result?.ok) throw new Error(result?.error?.message || "消息发送失败");
                            return { submitted:true };
                        });
                }
                if (/^\s*\/(?:pass|return|findentry|findlore|findwi)(?:\s|$)/i.test(String(line))) return executeReadPipeline(String(line), sessionId);
                if (/^\/ejs(?:-refresh)?(?:\s|$)/.test(String(line))) return rpc("executeFullTemplateCommand", {text:line}, sessionId).then(function(result){return result.pipe;});
				const draftMatch = /^\/setinput(?: ([\s\S]*))?$/.exec(String(line || ""));
                // Preflight before touching the composer: otherwise the greedy
                // send match silently includes unsupported commands in the draft.
                const pipes = draftMatch ? [] : Array.from(String(line || "").matchAll(/\|\s*(\/[\w-]+)/g));
                const unsupported = pipes.find((part, index) => part[1] !== "/trigger" || index !== pipes.length - 1);
                if (!draftMatch && (/^\/cut(?:\s|$)/.test(String(line)) || unsupported || (pipes.length && !/^\/send\s/.test(String(line))))) {
                    const command = unsupported ? unsupported[1] : /^\/cut(?:\s|$)/.test(String(line)) ? "/cut" : pipes[0][1];
                    const error = new Error("暂不支持人物卡命令管道中的 " + command + "，未发送消息。当前支持 /send … | /trigger；/cut 删除楼层尚未实现。");
                    error.code = "UNSUPPORTED_SLASH_PIPELINE";
                    return Promise.reject(error);
                }
				const match = /^\/send\s+([\s\S]+?)\s*\|\s*\/trigger(?:\s+await=(true|false))?\s*$/i.exec(String(line || ""));
				const sendOnly = !pipes.length ? /^\/send\s+([\s\S]+)$/.exec(String(line || "")) : null;
				const triggerMatch = /^\/trigger(?:\s+await=(true|false))?\s*$/i.exec(String(line || ""));
				const triggerOnly = Boolean(triggerMatch);
				if (!draftMatch && !triggerOnly && (!sendOnly || !sendOnly[1].trim()) && (!match || !match[1].trim())) {
                    if (!ctx.remote?.commands?.execute) return Promise.reject(new Error("当前酒馆没有注册这条命令"));
                    return ctx.remote.commands.execute(sessionId, String(line), []).then(function (execution) {
                        if (!execution) throw new Error("当前酒馆没有注册这条命令");
                        if (execution.result?.kind === "error") throw new Error(execution.result.text || "命令执行失败");
                        return String(execution.result?.text || "");
                    });
                }
				const actx = ctx.sessions.scope(sessionId);
				const conversation = ctx.get("conversation");
				if (!actx || !conversation) return Promise.reject(new Error("当前对话输入框不可用"));
				const input = conversation.input.for(actx);
				if (draftMatch) { pendingSend.delete(sessionId); input.setDraft(draftMatch[1] || ""); return Promise.resolve({ drafted: true }); }
				if (sendOnly) {
					pendingSend.set(sessionId, { text: sendOnly[1], at: Date.now() });
					input.setDraft(sendOnly[1]);
					return Promise.resolve({ drafted: true, deferred: true, pipe: "" });
				}
                if (submitting.has(sessionId)) return Promise.reject(new Error("本局正在提交生成，请等待当前操作完成"));
                function actualDraft() {
                    const state = input.state && typeof input.state.getSnapshot === "function" ? input.state.getSnapshot() : null;
                    return state && typeof state.draft === "string" ? state.draft : undefined;
                }
				let pendingEntry = pendingSend.get(sessionId);
                const draft = actualDraft();
                if (pendingEntry && (Date.now() - pendingEntry.at > 15000 || (draft !== undefined && draft !== pendingEntry.text))) {
                    pendingSend.delete(sessionId);
                    pendingEntry = undefined;
                }
				const stagedSend = triggerOnly && pendingEntry ? pendingEntry.text : undefined;
				const submitDraftText = match ? match[1] : stagedSend;
				const useNativeTrigger = triggerOnly && submitDraftText === undefined;
				const binding = ctx.sessions.binding(sessionId);
                let submissionAccepted = false;
                if (submitDraftText !== undefined && pendingEntry && !pendingEntry.requestId) pendingEntry.requestId = createSubmissionRequestId();
                const submissionRequestId = submitDraftText === undefined ? null : pendingEntry ? pendingEntry.requestId : createSubmissionRequestId();
                // DSH requires nonempty prompt content. Helper messages are already
                // persisted; admit a continuation without resending them or touching the draft.
                const triggerContent = [{ type: "text", text: "继续。" }];
                const waitForCompletion = options?.waitForCompletion !== false && String((match && match[2]) || (triggerMatch && triggerMatch[1]) || "").toLowerCase() !== "false";
                function consumePending() {
                    if (pendingSend.get(sessionId) === pendingEntry) pendingSend.delete(sessionId);
                }
                function submit() {
                    if (stagedSend !== undefined) {
                        const currentDraft = actualDraft();
                        if (pendingSend.get(sessionId) !== pendingEntry || (currentDraft !== undefined && currentDraft !== stagedSend)) {
                            throw new Error("输入草稿已变化，请重新发送");
                        }
                    }
                    if (!binding?.session) throw new Error("当前对话已关闭");
                    if (useNativeTrigger) return binding.session.prompt(triggerContent, "queue");
                    return binding.session.prompt([{ type: "text", text: submitDraftText }], "queue", undefined, submissionRequestId);
                }
                function accept(result) {
                    if (!result?.ok) throw new Error(result?.error?.message || "生成提交失败");
                    submissionAccepted = true;
                    if (submitDraftText !== undefined && actualDraft() === submitDraftText) input.setDraft("");
                    consumePending();
                    // The player row was saved before generation. Acceptance only adds
                    // the assistant placeholder to that same story projection.
                    storyChanged(sessionId);
                }
                function submitTurn() {
                    // Template execution owns the generation queue; waiting here would deadlock it.
                    if (!waitForCompletion) {
                        return Promise.resolve().then(submit).then(function(result) { accept(result); return {submitted:true}; });
                    }
                    const sessions = ctx.sessions.list;
                    return new Promise(function (resolve, reject) {
                        let observedRun = false;
                        let accepted = false;
                        let runFinished = false;
                        let settled = false;
                        let stop = function () {};
                        let timer = null;
                        function finish(error) {
                            if (settled) return;
                            settled = true;
                            hostWindow.clearTimeout(timer);
                            stop();
                            if (error) reject(error); else resolve({ submitted: true });
                        }
                        function inspect() {
                            const summary = sessions.getSnapshot().byId[sessionId];
                            if (!summary) { finish(new Error("当前对话已关闭")); return; }
                            if (summary.running === true) observedRun = true;
                            else if (observedRun) { runFinished = true; if (accepted) finish(); }
                        }
                        stop = sessions.subscribe(inspect);
                        timer = hostWindow.setTimeout(function () { finish(new Error("等待开局生成完成超时")); }, 15 * 60 * 1000);
                        try {
                            Promise.resolve(submit()).then(function (result) {
                                accept(result);
                                accepted = true;
                                if (runFinished) finish(); else inspect();
                            }).catch(finish);
                            inspect();
                        } catch (error) { finish(error); }
                    });
                }
                // Reserve synchronously so concurrent triggers cannot consume one staged send twice.
                submitting.add(sessionId);
                return Promise.resolve().then(function () {
                    // Saving the player row is independent of Session/LLM acceptance.
                    if (submitDraftText !== undefined) return persistPlayerInput(sessionId, submitDraftText, submissionRequestId);
                }).then(function () {
                    if (typeof flushTavernSessionFramesBeforeGenerate === "function") return flushTavernSessionFramesBeforeGenerate(sessionId);
                }).then(submitTurn).catch(function (error) {
                    // Keep the same request id for a retry. appendPlayerInput is
                    // idempotent, and a saved player row is never abandoned here.
                    if (!submissionAccepted && submitDraftText !== undefined) {
                        if (pendingEntry && pendingSend.get(sessionId) === pendingEntry) pendingEntry.at = Date.now();
                        else if (!pendingEntry) {
                            pendingEntry = { text: submitDraftText, at: Date.now(), requestId: submissionRequestId };
                            pendingSend.set(sessionId, pendingEntry);
                            if (actualDraft() === "") input.setDraft(submitDraftText);
                        }
                    }
                    throw error;
                }).finally(function () { submitting.delete(sessionId); });
			};
			execute.readInput = readInputDraft;
			return execute;
		}
