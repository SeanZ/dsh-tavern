		// The regeneration RPC returns only after the model finishes, while its durable
		// regenInProgress marker is written after request preparation. Keep re-reading
		// until that marker is actually visible; a fixed burst can all run before the
		// marker exists and leaves the replaced reply on screen for the whole request.
		function createTavernRegenerationViewRefresher(options) {
			const liveView = options.liveTavernView;
			const storyChanged = options.storyChanged || function () {};
			const schedule = options.schedule || function (run, delay) { return window.setTimeout(run, delay); };
			const cancel = options.cancel || function (timer) { window.clearTimeout(timer); };
			const pending = new Map();
			function stop(id) {
				const ticket = pending.get(id);
				if (!ticket) return;
				pending.delete(id);
				if (ticket.timer !== null) cancel(ticket.timer);
			}
			function refresh(id) {
				liveView.invalidate(id);
				try { storyChanged(id); } catch (_) { /* the live view still refreshes without DOM events */ }
			}
			return function notifyRegenerating(sessionId, active) {
				const id = String(sessionId || "");
				if (id === "") return;
				stop(id);
				refresh(id);
				if (active !== true) return;
				const ticket = { timer: null };
				pending.set(id, ticket);
				function confirmMarker() {
					if (pending.get(id) !== ticket) return;
					refresh(id);
					if (pending.get(id) !== ticket) return;
					const snapshot = liveView.getSnapshot(id);
					if (snapshot && snapshot.view && snapshot.view.regenInProgress === true) {
						pending.delete(id);
						return;
					}
					ticket.timer = schedule(confirmMarker, 500);
				}
				ticket.timer = schedule(confirmMarker, 500);
			};
		}

		function createPlayControlsFeatureModule() {
			const historyProjection = createTurnHistoryProjection();
            const displayRefreshes = new Map();
            function refreshDisplay(sessionId) {
                if (displayRefreshes.has(sessionId)) return displayRefreshes.get(sessionId);
                const work = rpc("refreshSessionDisplay", {}, sessionId).then(function (result) {
                    if (!result || !result.view) throw new Error("刷新显示未返回当前会话");
                    // setView 取消此前在途刷新，防止旧响应覆盖手动重算的结果。
                    liveTavernView.setView(sessionId, result.view);
                    return result;
                });
                displayRefreshes.set(sessionId, work);
                const clear = function () { if (displayRefreshes.get(sessionId) === work) displayRefreshes.delete(sessionId); };
                work.then(clear, clear);
                return work;
            }
            const { TavernConversationSettingsTab, TavernConversationSettingsAction } = createConversationSettingsModule({
                React, rpc, useLiveTavernView, useTavernSessionMode, isPlayMode,
                invalidateView: sessionId => liveTavernView.invalidate(sessionId),
                notifyTavernDataChanged,
                UserPreferenceProfileTab, TavernConversationWritingSkills, backgroundModelLabel
            });
			function TavernConversationExportAction(props) {
                // The header only needs session membership. Building a complete
                // Tavern view here delays the button behind templates and history.
                const owner = props.sessions.subagentAddress(props.sessionId)?.parentSessionId || props.sessionId;
                const mode = useTavernSessionMode(owner);
                const available = Boolean(mode);
                const [busy, setBusy] = React.useState(false);
                const [open, setOpen] = React.useState(false);
                const [refreshLabel, setRefreshLabel] = React.useState("刷新显示");
                const root = React.useRef(null);
                const currentSession = React.useRef(props.sessionId);
                currentSession.current = props.sessionId;
                // 「底部面板」 opens or folds the bottom workbench (collapsed on a phone at load);
                // listed only while it holds tabs, since the host's own toggle is hidden in Tavern.
                const sidebar = props.sidebar;
                const bottom = React.useSyncExternalStore(React.useCallback(listener => sidebar && typeof sidebar.subscribeState === "function" ? sidebar.subscribeState(listener) : () => {}, [sidebar]),
                    () => tavernBottomPanel.tabs(sidebar) ? (tavernBottomPanel.open(sidebar) ? "open" : "closed") : "");
                // on a phone in play the ⋯ also holds the moved top-bar entries (phone-play.js).
                const phone = usePhonePlay(props.sessionId, props.sessions);
                React.useEffect(function () {
                    setOpen(false);
                    setRefreshLabel("刷新显示");
                }, [props.sessionId]);
                React.useLayoutEffect(function () {
                    if (open && phone && root.current) root.current.querySelectorAll(".dsh-tavern-more-menu button").forEach(function (node) { if (!node.closest(".fork-phone-readout")) node.setAttribute("role", "menuitem"); });
                });
                React.useEffect(function () {
                    if (!open) return;
                    // The readout's model and context popovers are portalled to <body>; using them keeps this menu open.
                    function outside(event) { if (!root.current || !root.current.contains(event.target) && !event.target.closest?.(".fork-model-panel, .fork-metrics-popover, .fork-metrics-tooltip")) setOpen(false); }
                    function escape(event) { if (event.key === "Escape") { setOpen(false); root.current?.querySelector("[aria-haspopup]")?.focus(); } }
                    document.addEventListener("pointerdown", outside, true);
                    document.addEventListener("keydown", escape);
                    return function () { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape); };
                }, [open]);
				if (!available) return null;
				async function exportText() {
					setBusy(true);
					try {
						const snapshot = props.sessions.list.getSnapshot();
						const summary = snapshot.byId && snapshot.byId[props.sessionId];
						const result = await rpc("exportConversation", { title: summary && summary.displayTitle || "" }, props.sessionId);
						// With illustrations the Markdown and its pictures arrive together as a zip.
						const blob = result.base64
							? new Blob([Uint8Array.from(atob(result.base64), function (value) { return value.charCodeAt(0); })], { type: "application/zip" })
							: new Blob([result.text], { type: "text/markdown;charset=utf-8" });
						downloadTavernBlob(blob, result.filename || "对话记录.md");
					} catch (err) { tavernErrorHub.report("导出故事正文", err); }
					finally { setBusy(false); }
				}
				async function exportSave() {
					setBusy(true);
					try {
						const result = await rpc("exportGameSave", { images: true }, props.sessionId);
						const bytes = Uint8Array.from(atob(result.base64), function (value) { return value.charCodeAt(0); });
						downloadTavernBlob(new Blob([bytes], { type: "application/zip" }), result.filename);
					} catch (err) { tavernErrorHub.report("导出存档", err); }
					finally { setBusy(false); }
				}
				async function exportLogs() {
					setBusy(true);
					try {
						// 只有显式导出日志时才让当前会话的卡片按预算采集 DOM；采集失败不影响导出。
						await tavernFrameDiagnostics.capture(props.sessionId).catch(function () {});
						const result = await rpc("exportTavernLogs", {}, props.sessionId);
						const bytes = Uint8Array.from(atob(result.base64), function (value) { return value.charCodeAt(0); });
						downloadTavernBlob(new Blob([bytes], { type: "application/zip" }), result.filename);
					} catch (err) { tavernErrorHub.report("导出日志", err); }
					finally { setBusy(false); }
				}
                async function refreshCurrentDisplay() {
                    if (busy) return;
                    const sessionId = props.sessionId;
                    setBusy(true); setRefreshLabel("正在刷新…");
                    try { await refreshDisplay(sessionId); if (currentSession.current === sessionId) setRefreshLabel("显示已刷新"); }
                    catch (error) { if (currentSession.current === sessionId) { setRefreshLabel("刷新显示"); tavernErrorHub.report("刷新显示", error); } }
                    finally { setBusy(false); }
                }
                const refreshItem = owner === props.sessionId && isPlayMode(mode) ? React.createElement("button", { key: "refresh-display", type: "button", role: "menuitem", "data-keep-open": "", disabled: busy, title: "重新读取这一局的存档并计算显示，保留剧情和变量", onClick: refreshCurrentDisplay }, refreshLabel) : null;
				const exportItems = [
                        React.createElement("button", { key: "save", type: "button", role: "menuitem", disabled: busy, title: "导出这一局的存档，可在其他电脑的酒馆里导入继续玩", onClick: exportSave }, "存档"),
                        React.createElement("button", { key: "logs", type: "button", role: "menuitem", "data-tavern-log-export": "", disabled: busy, "aria-label": "日志", title: "下载 Session、MVU、生图与更新日志；含私人剧情，分享前请检查隐私", onClick: exportLogs }, "日志（用于排查错误）"),
                        React.createElement("button", { key: "text", type: "button", role: "menuitem", disabled: busy, title: "导出玩家与角色正文的 Markdown；有配图时连同图片打包为 zip", onClick: exportText }, "故事正文")];
                const bottomItem = bottom ? React.createElement("button", { key: "bottom", type: "button", role: "menuitemcheckbox", "aria-checked": bottom === "open", title: "底部面板", onClick: function () { tavernBottomPanel.toggle(); } }, bottom === "open" ? "收起底部面板" : "底部面板") : null;
				return React.createElement("div", { className: "dsh-tavern-more-actions dsh-tavern-export-menu", ref: root },
                    React.createElement("button", { type: "button", className: "dsh-tavern-export-action", "aria-haspopup": "menu", "aria-expanded": open, "aria-busy": busy, "aria-label": "更多", title: phone ? "更多" : "更多：导出存档、日志、纯对话 TXT", "data-fork-more": "", onClick: function () { setOpen(value => !value); } }, busy ? "…" : "⋯"), // low-frequency, folded behind ⋯
                    React.createElement("div", { className: "dsh-tavern-more-menu" + (phone ? " fork-phone-more-menu" : ""), role: "menu", "aria-label": phone ? "更多" : "导出", hidden: !open, onKeyDown: phone ? phoneModMenuKeys : undefined,
                        onClick: function (event) { if (event.target.closest("button:not(:disabled)") && !event.target.closest("[data-keep-open]")) setOpen(false); } },
                        phone ? React.createElement(PhonePlayMoreItems, { open, sessionId: props.sessionId, exportItems, extraItems: [refreshItem, bottomItem], renderSlot: open ? props.renderSlot : null, openStatus: function () { props.openStatus(owner); } })
                            : React.createElement(React.Fragment, null, refreshItem, exportItems, bottomItem)
                    ));
            }

			function TavernCompactionAction(props) {
				const [busy, setBusy] = React.useState(false);
				const [resultLabel, setResultLabel] = React.useState("");
				const [resultTitle, setResultTitle] = React.useState("");
				const running = props.useSession(function (snapshot) { return snapshot.running; });
				// all button instances share foreground + background progress.
				const compaction = useCompactionState(props.sessionId);
				const compacting = busy || compaction.running;
				async function compactContext() {
					if (compacting || running) return;
					setBusy(true);
					setResultLabel("");
					setResultTitle("");
					compactionRuns.set(props.sessionId, { phase: "running" }); // joint toolbar progress
					try {
                        const response = await rpc("runCompaction", {}, props.sessionId);
                        const operation = response.result;
                        if (!operation) throw new Error("当前会话不支持剧情压缩");
                        setResultTitle(compactionProgressTitle(operation));
                        if (operation.status !== "completed") throw new Error("上下文压缩未全部完成。" + compactionProgressTitle(operation));
                        setResultLabel(operation.backgroundSessionId ? "前台和后台已压缩" : "前台已压缩");
						compactionRuns.set(props.sessionId, null);
					} catch (err) { compactionRuns.set(props.sessionId, { phase: "failed", message: String(err && err.message || err) }); }
					finally { setBusy(false); liveTavernView.invalidate(props.sessionId); }
				}
				const progress = compactionProgressTitle(compaction.operation);
				const title = compacting ? "压缩中…" + (progress ? " " + progress : "") : resultTitle || progress || "压缩上下文";
				return React.createElement("button", { className: props.inMenu ? "" : "dsh-tavern-choice-trigger", role: props.inMenu ? "menuitem" : undefined, disabled: compacting || running, "aria-busy": compacting, "aria-label": compacting ? "压缩中…" : "压缩上下文", title: title, onClick: compactContext }, compacting ? "压缩中…" : (resultLabel || "压缩上下文"));
			}

			// @include modules/story-ledger.js

			// @include modules/mvu-variables.js

			// @include script-navigation.js

        function TavernSaveUpgrade(props) {
            const [state, setState] = React.useState(null);
            const [error, setError] = React.useState("");
            const [started, setStarted] = React.useState(false);
            const [requestBusy, setRequestBusy] = React.useState(false);
            const [refresh, setRefresh] = React.useState(0);
            React.useEffect(function () {
                let disposed = false, timer;
                async function read() {
                    try {
                        const next = await rpc("getSaveUpgrade", {}, props.sessionId);
                        if (disposed) return;
                        setState(next); setError("");
                        if (next.phase === "running") timer = setTimeout(read, 1000);
                        else if (next.phase === "completed" && started) liveTavernView.invalidate(props.sessionId);
                    } catch (err) { if (!disposed) setError(String(err.message || err)); }
                }
                read();
                return function () { disposed = true; clearTimeout(timer); };
            }, [props.sessionId, refresh, started]);
            async function migrate() {
                if (requestBusy || state?.phase === "running") return;
                setRequestBusy(true); setError("");
                try {
                    await rpc("upgradeSave", {}, props.sessionId);
                    setStarted(true); setRefresh(value => value + 1);
                } catch (err) { setError(String(err.message || err)); }
                finally { setRequestBusy(false); }
            }
            if (!state && !error || state?.storage === "current" && state?.sessions?.ready) return null;
            const h = React.createElement;
            const busy = requestBusy || state?.phase === "running";
            const stage = {sessions:"正在检查会话日志迁移…",reading:"正在读取剧情与变量…",converting:"正在迁移存储并读回存档…",verifying:"正在校验剧情、变量和历史版本…"}[state?.stage] || "正在迁移…";
            return h("section", {className:"dsh-tavern-status-section", "aria-label":"存档迁移"},
                h("div", {className:"dsh-tavern-status-label"}, "存档迁移"),
                h("div", {className:"dsh-tavern-status-empty"}, "统一迁移本局的会话日志与剧情存储，保留正文、变量、分支和历史版本。旧文件保留原样；迁移后的新进度写入新版存档。"),
                busy ? h("div", {role:"status"}, stage + " 大存档可能需要较长时间，暂时不要关闭或重启酒馆。") : null,
                error || state?.phase === "failed" ? h("div", {className:"dsh-card-error",role:"alert"}, error || state.error) : null,
                state?.sessions?.warning && state.phase !== "failed" ? h("div", {className:"dsh-tavern-status-empty",role:"note"}, state.sessions.warning) : null,
                state?.phase === "failed" && !state.sessions?.ready ? h("div", {className:"dsh-tavern-status-empty"}, "这局的旧会话日志暂时无法升级，原档已保留。请点「导出诊断文件」，把文件发给开发者（不含剧情正文）；修复发布后更新酒馆即可自动升级。想先接着玩，可以在左侧对话菜单「⋯」里用「存档救援」把剧情转到新对话。") : null,
                state?.phase === "failed" && !state.sessions?.ready ? h("button", {type:"button",className:"dsh-tavern-btn",onClick:() => downloadSessionDiagnostics({}, props.sessionId).catch(err => setError("导出诊断文件失败：" + String(err.message || err)))}, "导出诊断文件") : null,
                !state ? h("button", {className:"dsh-tavern-btn",onClick:()=>setRefresh(value=>value+1)}, "重新检查存档迁移") :
                h("button", {type:"button",className:"dsh-tavern-btn",disabled:busy || props.busy,onClick:migrate}, busy ? "迁移中…" : state.phase === "failed" ? "重试迁移" : "迁移存档"),
                !busy && props.busy ? h("div", {className:"dsh-tavern-status-empty"}, "请等待本轮游玩和后台结算完成后再迁移。") : null
            );
        }

			function TavernStatusPanel(props) {
				const [designRemoving, setDesignRemoving] = React.useState("");
            const askConfirm = useTavernConfirm(props.sessionId || props.scope?.sessionId);
			const [error, setError] = usePersistentError("酒馆状态");
			const [guideDraft, setGuideDraft] = React.useState("");
			const guideInputRef = React.useRef(null);
			const [guideBusy, setGuideBusy] = React.useState(false);
            const [guideNotice, setGuideNotice] = React.useState("");
			const [guideError, setGuideError] = usePersistentError("Guide");
            const [styleDraft, setStyleDraft] = React.useState("");
            const [styleBusy, setStyleBusy] = React.useState(false);
            const [styleError, setStyleError] = React.useState("");
            const [styleEditing, setStyleEditing] = React.useState(false);
            const [styleExpanded, setStyleExpanded] = React.useState(false);
			const [settlementRetryBusy, setSettlementRetryBusy] = React.useState(false);
			const [cardUpdateBusy, setCardUpdateBusy] = React.useState(false);
            const [cardUpdateError, setCardUpdateError] = React.useState("");
			const running = props.useSession(function (snapshot) { return snapshot.running; });
			const latestMessageId = props.useChat(latestTavernAssistantMessageId);
			const stateKey = String(running) + ":" + String(latestMessageId || "");
			const liveState = useLiveTavernView(props.sessionId, stateKey);
			const view = liveState.view;
			const loadState = liveState.phase;
            React.useEffect(function () {
                if (view?.characterDesignTask?.status === "done" && view.characterDesignTask.published?.length) notifyTavernDataChanged(["worldbooks", "cards"], "character-design");
            }, [props.sessionId, JSON.stringify(view?.characterDesignTask?.published || [])]);
			const missingCard = isMissingTavernCardError(liveState.error);
			const debugTurns = view && Array.isArray(view.debugTurns) ? view.debugTurns : [];
			const latestDebugTurn = Number(debugTurns[0] && debugTurns[0].turn) || 0;
			React.useEffect(function () {
				setError(missingCard ? "" : (liveState.error || ""));
			}, [liveState.error, missingCard]);
            const [resourceLinkBusy, setResourceLinkBusy] = React.useState(false);
            const [resourceLinkError, setResourceLinkError] = React.useState("");
            const [resourceBinding, setResourceBinding] = React.useState(null);
            React.useEffect(function () {
                const cardPath = view?.card?.path;
                let active = true, revision = 0;
                setResourceBinding(null); setResourceLinkError("");
                async function refreshBinding() {
                    if (!cardPath) return;
                    const request = ++revision;
                    try {
                        const result = await rpc("getWorldBookBinding", { cardPath }, props.sessionId);
                        if (active && request === revision) setResourceBinding({ cardPath, binding: result.binding });
                    } catch (_) {
                        if (active && request === revision) setResourceBinding({ cardPath, failed: true });
                    }
                }
                function onData(event) { if (tavernDataChangeAffects(event, ["worldbooks", "cards"])) refreshBinding(); }
                refreshBinding();
                window.addEventListener("dsh-tavern-data-changed", onData);
                return () => { active = false; window.removeEventListener("dsh-tavern-data-changed", onData); };
            }, [props.sessionId, view?.card?.path]);
            const currentResourceBinding = resourceBinding?.cardPath === view?.card?.path ? resourceBinding : null;
            const primaryWorldBook = currentResourceBinding?.binding?.books?.[0] || currentResourceBinding?.binding;
            const noWorldBook = currentResourceBinding && !currentResourceBinding.failed && !primaryWorldBook?.source;
            const unavailableWorldBook = primaryWorldBook?.source && !primaryWorldBook.available;
            async function openWorldBookDetail() {
                setResourceLinkBusy(true); setResourceLinkError("");
                try {
                    const result = await rpc("getWorldBookBinding", { cardPath: view.card.path }, props.sessionId);
                    const binding = result.binding?.books?.[0] || result.binding;
                    setResourceBinding({ cardPath: view.card.path, binding: result.binding });
                    if (!binding?.source) { setResourceLinkError("本局人物卡尚未绑定世界书。"); return; }
                    if (!binding.available) { setResourceLinkError("绑定的世界书已不可用，请在人物卡详情中检查绑定。"); return; }
                    props.openStyleTab("dsh-tavern:worldbooks", { worldBookSource: binding.source });
                } catch (err) { setResourceLinkError(String(err && err.message || err)); }
                finally { setResourceLinkBusy(false); }
            }
			async function addGuide() {
				const text = guideDraft.trim();
				if (!text) return;
				setGuideBusy(true); setGuideError("");
				try {
					await rpc("addGuide", { text: text }, props.sessionId);
					liveTavernView.invalidate(props.sessionId);
					setGuideDraft("");
				} catch (err) { setGuideError(String(err && err.message || err)); }
				finally { setGuideBusy(false); }
			}
            async function retryStyleReference() {
                setStyleBusy(true); setStyleError("");
                try {
                    await rpc("retryStyleReference", { guidance: styleDraft.trim() }, props.sessionId);
                    liveTavernView.invalidate(props.sessionId);
                    setStyleDraft(""); setStyleEditing(false); setStyleExpanded(false);
                } catch (err) { setStyleError(String(err && err.message || err)); }
                finally { setStyleBusy(false); }
            }
            async function saveGuideLibrary() {
                if (guideBusy || !(view.guides || []).length) return;
                const name = await askTavernText({ title: "Guide 方案名称", initialValue: "本局 Guide", maxLength: 80 });
                if (!name) return;
                setGuideBusy(true); setGuideError(""); setGuideNotice("");
                try {
                    await rpc("saveGuideLibrary", { name }, props.sessionId);
                    notifyTavernDataChanged(["guide-library"], "guide-library");
                    setGuideNotice("已保存到Guide 库，本局 Guide保持不变。");
                } catch (err) { setGuideError(String(err.message || err)); }
                finally { setGuideBusy(false); }
            }
			async function removeGuide(guide, index) {
				setGuideBusy(true); setGuideError("");
				try {
					await rpc("deleteGuide", guide.id ? { id: guide.id } : { index, expected: guide }, props.sessionId);
					liveTavernView.invalidate(props.sessionId);
				} catch (err) { setGuideError(String(err && err.message || err)); }
				finally { setGuideBusy(false); }
			}
			// Card and world book edits load by themselves; this is a legacy save's manual sync or a retry.
			async function applyUpdatedCard() {
				if (cardUpdateBusy || !view?.cardUpdate || view.cardUpdate.error) return;
				setCardUpdateBusy(true); setCardUpdateError("");
				try { await rpc("applyUpdatedCard", { digest: view.cardUpdate.digest }, props.sessionId); liveTavernView.invalidate(props.sessionId); }
				catch (error) { setCardUpdateError(String(error.message || error)); }
				finally { setCardUpdateBusy(false); }
			}
			async function retrySettlement() {
				if (!view || settlementRetryBusy) return;
				setSettlementRetryBusy(true);
				try {
					await rpc("retrySettlement", { turn: view.settlementTurn }, props.sessionId);
					liveTavernView.invalidate(props.sessionId);
				} catch (retryError) { tavernErrorHub.report("重试后台结算", retryError); }
				finally { setSettlementRetryBusy(false); }
			}
			async function removeCharacterDesign(name) {
				if (designRemoving || !await askConfirm("删除人物档案“" + name + "”？会同时移除本局世界书里为它生成的条目（手动改过的条目保留），人物卡的世界书库不变。")) return;
				setDesignRemoving(name);
				try {
					const result = await rpc("removeCharacterDesign", { name: name }, props.sessionId);
					if (result.worldbookEdited) tavernErrorHub.report("删除人物档案", new Error("档案已删除；本局世界书里“" + name + "”的条目被手动改过，已保留，如需移除请到世界书中处理。"));
					liveTavernView.invalidate(props.sessionId);
				} catch (error) { tavernErrorHub.report("删除人物档案", error); }
				finally { setDesignRemoving(""); }
			}
			async function designCharacter(initialValue = "") {
                await askTavernText({ title: "设计人物", description: "设计意见（选填）。留空则根据当前剧情和已有档案设计人物。", initialValue, allowEmpty: true, maxLength: 4000, confirmLabel: "开始设计",
                    onSubmit: async guidance => { await rpc("designCharacter", { guidance }, props.sessionId); liveTavernView.invalidate(props.sessionId); }
                });
            }
            React.useEffect(function () {
                if (!["running", "queued"].includes(view?.characterDesignTask?.status)) return;
                const timer = setInterval(() => liveTavernView.invalidate(props.sessionId), 2000);
                return () => clearInterval(timer);
            }, [props.sessionId, view?.characterDesignTask?.status]);
			function characterDesignTime(ts) {
				if (!ts) return "";
				const date = new Date(ts);
				return (date.getMonth() + 1) + "/" + date.getDate() + " " + String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
			}
			const h = React.createElement;
			if (!view) return h("aside", { className: "dsh-tavern-status dsh-tavern-status-dashboard" },
				h("div", { className: "dsh-tavern-status-head" }, h("div", { className: "dsh-tavern-status-title" }, "状态栏")),
				h("div", { className: "dsh-tavern-status-body" },
					h("div", { className: "dsh-tavern-status-empty" }, missingCard ? "人物卡已删除，酒馆状态不可用；已有对话仍可查看。" : (loadState === "retrying" ? "正在重新连接酒馆状态…" : (error || (loadState === "loading" ? "正在加载酒馆状态…" : "选择人物卡后，这里会显示持续状态。")))),
					loadState === "retrying" || missingCard ? h("button", { className: "dsh-tavern-btn", onClick: function () { liveTavernView.invalidate(props.sessionId); } }, "重新加载") : null
				)
			);
			if (view.mode === "card") return null;
			// rendering moved to status-panel.js (StatusPanelView).
			return h(StatusPanelView, { view: view, running: running, props: props, guideDraft: guideDraft, setGuideDraft: setGuideDraft, guideBusy: guideBusy, guideError: guideError, guideInputRef: guideInputRef,
				guideNotice, saveGuideLibrary, resourceLinkBusy, currentResourceBinding, noWorldBook, unavailableWorldBook, resourceLinkError, openWorldBookDetail,
                styleDraft, setStyleDraft, styleBusy, styleError, retryStyleReference, styleEditing, setStyleEditing, styleExpanded, setStyleExpanded,
                addGuide: addGuide, removeGuide: removeGuide, cardUpdateBusy: cardUpdateBusy, cardUpdateError: cardUpdateError, applyUpdatedCard: applyUpdatedCard,
				settlementRetryBusy: settlementRetryBusy, retrySettlement: retrySettlement, latestDebugTurn: latestDebugTurn, designCharacter: designCharacter, designRemoving, removeCharacterDesign });
		}

		// @include status-panel.js
		// @include gal-choices.js

		const TAVERN_CARD_APP_IDLE = Object.freeze({ visible: false, attached: false, recovering: false, expanded: false });

		function TavernCardAppDock(props) {
			const slotRef = React.useRef(null);
			const controllerRef = React.useRef(null);
			const activeRef = React.useRef(props.active !== false);
			activeRef.current = props.active !== false;
			const [presence, setPresence] = React.useState(TAVERN_CARD_APP_IDLE);
			React.useEffect(function () {
				setPresence(TAVERN_CARD_APP_IDLE);
				if (!slotRef.current) return;
				const presenceStore = createTavernCardAppPresence({ onChange: setPresence });
				const controller = createTavernCardAppDock({
					document: document,
					slot: slotRef.current,
					sessionId: props.sessionId,
					active: activeRef.current,
					onChange: presenceStore.change
				});
				controllerRef.current = controller;
				return function () {
					controllerRef.current = null;
					controller.dispose();
					presenceStore.dispose();
				};
			}, [props.sessionId]);
			React.useEffect(function () {
				if (controllerRef.current && typeof controllerRef.current.setActive === "function") {
					controllerRef.current.setActive(props.active !== false);
				}
			}, [props.active]);
			return React.createElement("section", { className: "dsh-tavern-status-section dsh-tavern-card-app-section", hidden: !presence.visible },
				React.createElement("div", { className: "dsh-tavern-card-app-head" },
					React.createElement("div", { className: "dsh-tavern-status-label" }, "人物卡应用"),
					React.createElement("div", { className: "dsh-tavern-card-app-actions" },
						presence.attached ? React.createElement("button", { type: "button", className: "dsh-tavern-btn", title: "刷新手机界面", onClick: function () { if (controllerRef.current) controllerRef.current.trigger("刷新"); } }, "刷新") : null,
						React.createElement("button", { type: "button", className: "dsh-tavern-btn", disabled: !presence.attached, onClick: function () { if (controllerRef.current) controllerRef.current.toggle(); } }, presence.attached ? (presence.expanded ? "收起手机" : "打开手机") : "恢复中…")
					)
				),
				presence.recovering ? React.createElement("div", { className: "dsh-tavern-card-app-recovering", role: "status" }, "正在恢复人物卡应用…") : null,
				React.createElement("div", { ref: slotRef, className: "dsh-tavern-card-app-slot", "data-collapsed": presence.attached && !presence.expanded ? "true" : undefined })
			);
		}

		function TavernStatusTab(props) {
			const binding = React.useSyncExternalStore(
				function (listener) { return props.sessions.list.subscribe(listener); },
				function () { return props.sessions.binding(props.sessionId); },
				function () { return props.sessions.binding(props.sessionId); }
			);
			const activeSessionId = React.useSyncExternalStore(
				function (listener) { return props.sessions.list.subscribe(listener); },
				function () { return String(tavernMainSessionId(props.sessions) || ""); },
				function () { return String(tavernMainSessionId(props.sessions) || ""); }
			);
			const active = !activeSessionId || activeSessionId === String(props.sessionId || "");
			const h = React.createElement;
			if (!binding) return h("aside", { className: "dsh-tavern-status" },
				h("div", { className: "dsh-tavern-status-head" }, h("div", { className: "dsh-tavern-status-title" }, "酒馆状态")),
				h("div", { className: "dsh-tavern-status-body" }, h("div", { className: "dsh-tavern-status-empty" }, "正在连接当前会话…"))
			);
			function useSession(selector) {
				return React.useSyncExternalStore(
					function (listener) { return binding.session.subscribe(listener); },
					function () { return selector(binding.session.getSnapshot()); },
					function () { return selector(binding.session.getSnapshot()); }
				);
			}
			const chat = resolveConversationChatBinding(props.uiConversation, binding);
			function useChat(selector) {
				return React.useSyncExternalStore(
					function (listener) { return chat.subscribe(listener); },
					function () { return selector(chat.getSnapshot()); },
					function () { return selector(chat.getSnapshot()); }
				);
			}
			return h(TavernStatusPanel, { sessionId: props.sessionId, active: active, useSession: useSession, useChat: useChat, executeSlash: props.executeSlash, openStyleTab: props.openStyleTab });
		}

        const notifyRegenerating = createTavernRegenerationViewRefresher({
            liveTavernView,
            storyChanged: id => {
                if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("dsh-tavern-story-mutated", { detail: { sessionId: id } }));
            }
        });
        const interactions = createPlayInteractionFlow({ rpc, coordinationView, coordination: tavernCoordination,
            applyBodyResult: (sessionId, view, tail) => applyBodyRegenerationResult({ liveTavernView, historyProjection, sessionId, view, tail }),
            reportError: (source, error) => tavernErrorHub.report(source, error),
            notifyRegenerating,
            bodyErrorText: error => playerErrorText(error, { fallback: "重新生成没有完成" }), timers: window
        });
        const setCandidatePanel = interactions.candidates.set;
        const setCandidateGuidePanel = interactions.guide.set;
        const setRegenPanel = interactions.regeneration.set;
        const { readyCandidatePanel, submitCandidateTask, submitBodyRegeneration } = interactions;
        function useInteractionPanel(store) { return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot); }
        function useCandidatePanel() { return useInteractionPanel(interactions.candidates); }
        function useCandidateGuidePanel() { return useInteractionPanel(interactions.guide); }
        function useRegenPanel() { return useInteractionPanel(interactions.regeneration); }
		// a dismissed candidate failure stays dismissed
		// across a reload; only the latest dismissed task is kept because only the latest round can show one.
		const CANDIDATE_ERROR_DISMISSED_KEY = "dsh-tavern:candidate-error-dismissed";
		function dismissCandidateError(panel) {
			if (panel && panel.taskKey) { try { window.sessionStorage.setItem(CANDIDATE_ERROR_DISMISSED_KEY, panel.taskKey); } catch (_) {} }
			setCandidatePanel(null);
		}
		function candidateErrorDismissed(taskKey) {
			try { return window.sessionStorage.getItem(CANDIDATE_ERROR_DISMISSED_KEY) === taskKey; } catch (_) { return false; }
		}

        // @include gal-regenerate.js

		// @include features/send-long-press.js

		// Clear the failed or stopped latest round back to before it began (story, variables
		// and progress stay as they were) and hand its input back to the box.
		async function withdrawFailedTavernTurn(sessionId, inputActions, currentDraft) {
			const result = await rpc("rollbackTurn", { expectedTurn: null }, sessionId) || {};
			historyProjection.rolledBack(sessionId, result.view);
			// The story transcript reads Chat.messages, not the native rows hidden above.
			// Re-read it now so the withdrawn persisted bubble leaves before a page reload.
			window.dispatchEvent(new CustomEvent("dsh-tavern-story-mutated", { detail: { sessionId: sessionId } }));
			setCandidatePanel(null); setRegenPanel(null); setCandidateGuidePanel(null);
			const text = String(result.view && result.view.clearedInput || "");
			if (text.trim() !== "") {
				const current = String(currentDraft || "");
				// Never glue the old input onto a new one: sent together, the reply acts out both.
				if (current.trim() === "" || current === text) inputActions.setDraft(text);
				else if (await askTavernConfirm("输入框里已有新的内容。要用撤回的原输入替换它吗？\n\n原输入：" + text, { confirmText: "替换", cancelText: "保留新内容" })) inputActions.setDraft(text);
			}
			return result;
		}

		// Any problem in a game (a card that will not play, wrong display, slowness, a plain question)
		// goes to the debugging Agent in the card workbench, with this game attached as evidence.
		function TavernDebugButton(props) {
			const [busy, setBusy] = React.useState(false);
			const live = useLiveTavernView(props.sessionId, "debug");
			const turn = Number(props.turn) || Number(live.view && live.view.debugTurns && live.view.debugTurns[0] && live.view.debugTurns[0].turn) || 1;
			async function open() {
				if (busy) return;
				setBusy(true);
				try { await openPlayChatDebugWorkspace(props.sessionId, turn); }
				catch (error) { tavernErrorHub.report("交给调试 Agent", error); }
				finally { setBusy(false); }
			}
			return React.createElement("button", { type: "button", role: props.role, className: props.className, disabled: busy, onClick: open,
				title: "卡不能玩、显示异常、太卡太慢，或有疑问：在卡片工作台打开调试 Agent，并附上这一局的记录" }, busy ? "正在打开调试 Agent…" : (props.label || "交给调试 Agent"));
		}

		// @include features/play-turn-actions.js

		// @include variable-receipt.js
		// @include turn-actions.js
		// @include phone-play.js

		// the chat page's 回到最新, in the composer's top-right corner (O37), shown only while
		// scrolled away from the newest message. It replaces the host's 回到底部 (tavern.css hides it), whose own at-bottom
		// flag could stay stale after layout shifts; this one reads the scroller's geometry (jump-latest.js).
		function ChatJumpLatest() {
			const [box, setBox] = React.useState(null);
			const latest = useJumpLatest(box);
			const wrap = React.useCallback(function (node) { setBox(node && node.closest ? node.closest("[data-conversation-scroll]") : null); }, []);
			return React.createElement("span", { ref: wrap, className: "fork-chat-jump-latest" },
				React.createElement(JumpLatest, { skin: "chat", away: latest.away, onJump: latest.jump, focusAfter: function () {
					const input = box && box.querySelector("[data-composer-input]");
					if (input) input.focus({ preventScroll: true });
				} }));
		}

		function MobileComposerStatsToggle() {
			const [open, setOpen] = React.useState(false);
			const label = open ? "收起运行信息" : "展开运行信息";
			return React.createElement("button", {
				type: "button", className: "dsh-tavern-mobile-stats-toggle",
				"aria-label": label, title: label, "aria-expanded": open,
				onClick: function () { setOpen(!open); }
			}, React.createElement("span", { "aria-hidden": "true", className: "dsh-tavern-mobile-stats-glyph" }, "⌃"));
		}

		function CandidateDockActions(props) {
			const address = props.sessions && props.sessions.subagentAddress(props.sessionId);
			const ownerSessionId = address ? address.parentSessionId : props.sessionId;
			const sessionMode = useTavernSessionMode(ownerSessionId);
			const latestMessageId = props.useChat(latestTavernAssistantMessageId);
			const running = props.useSession(function (snapshot) { return snapshot.running === true; });
			const live = useLiveTavernView(ownerSessionId, String(running) + ":" + String(latestMessageId || ""));
			const imageTurn = Number(live.view && live.view.latestAssistantTurn) || 0;
			// 故事视图模式下候选项（生成候选项、下一步行动、带意见重新生成）整组撤下，其余按钮照常。
			const storyView = useTavernStoryViewMode(props.sessionId);
			const h = React.createElement;
			if (!sessionMode) return null;
			const compacting = live.view && live.view.contextCompaction && live.view.contextCompaction.operation && live.view.contextCompaction.operation.status === "running";
			const compactionStatus = live.view && live.view.contextCompaction && (compacting || live.view.contextCompaction.warning) ? h("span", { role: "status", className: "dsh-tavern-settings-desc fork-compaction-status" }, compacting ? "正在压缩前后台上下文…" : live.view.contextCompaction.warning,
				// a warning can be dismissed; it otherwise stays until a later compaction succeeds.
				!compacting && live.view.contextCompaction.warning ? h("button", { type: "button", className: "fork-compaction-dismiss", "aria-label": "关闭这条提示", title: "关闭这条提示", onClick: function () {
					rpc("dismissCompactionWarning", { sessionId: ownerSessionId }, ownerSessionId).then(function () { liveTavernView.invalidate(ownerSessionId); }, function (error) { tavernErrorHub.report("关闭压缩提示", error); });
				} }, "×") : null) : null;
			if (address) return isPlayMode(sessionMode) ? h("div", { className: "dsh-tavern-dock-actions" },
				h("div", { className: "dsh-tavern-dock-actions-primary" }, h(TavernStopBackgroundAction, { sessionId: ownerSessionId })),
				h(MobileComposerStatsToggle)) : null;
			return h("div", { className: "dsh-tavern-dock-actions",
				"data-compacting": live.view && live.view.contextCompaction && live.view.contextCompaction.operation && live.view.contextCompaction.operation.status === "running" || undefined },
				h("div", { className: "dsh-tavern-dock-actions-primary" },
					isPlayMode(sessionMode) && !storyView ? React.createElement(CandidateAction, Object.assign({}, props, { messageId: latestMessageId })) : null,
					isPlayMode(sessionMode) && live.view && !live.view.canClearIncompleteReply ? React.createElement(TavernPluginComposerActions, { sessionId: props.sessionId, turn: imageTurn, running: running }) : null),
				isPlayMode(sessionMode) ? React.createElement(TavernMoreActions, props) : React.createElement(TavernCompactionAction, props),
				React.createElement(MobileComposerStatsToggle),
                compactionStatus
			);
		}

        function observeTurnErrorProjection(root, apply, host = window) {
            let frame = null, disposed = false;
            const selector = '[data-chat-flow-kind], [data-turn-tail]';
            function containsRows(node) {
                return node.nodeType === 1 && (node.matches(selector) || !!node.querySelector(selector));
            }
            const observer = new host.MutationObserver(function (records) {
                if (disposed || !records.some(function (record) {
                    if (record.type === "attributes") return true;
                    // Native error contents may replace our controls; prose streaming cannot.
                    if (record.target.closest?.('[data-chat-flow-kind="turn-error"]')) return true;
                    return Array.from(record.addedNodes).some(containsRows) || Array.from(record.removedNodes).some(containsRows);
                })) return;
                if (frame === null) frame = host.requestAnimationFrame(function () {
                    frame = null;
                    if (!disposed) apply();
                });
            });
            observer.observe(root, { childList: true, subtree: true, attributes: true,
                attributeFilter: ["data-chat-flow-kind", "data-chat-flow-key", "data-chat-turn", "data-turn-tail"] });
            return { disconnect() {
                disposed = true; observer.disconnect();
                if (frame !== null) host.cancelAnimationFrame(frame);
                frame = null;
            } };
        }
		// the stage's 停止 while a reply is written. The host stops
		// the run and, when the body has not committed, withdraws the pick through the same failed-tail clearing as
		// 「撤回这条输入」 below (round-history interrupt). Resolves to the view (withdrawn, clearedInput) or null on error.
		async function interruptStageTurn(sessionId) {
			try {
				const result = await rpc("interruptTurn", {}, sessionId);
				const view = result && result.view || null;
				if (view && view.withdrawn) { historyProjection.rolledBack(sessionId, view); setCandidatePanel(null); setRegenPanel(null); setCandidateGuidePanel(null); }
				return view;
			} catch (error) { tavernErrorHub.report("停止生成", error); return null; }
			finally {
				notifyTavernDataChanged(["sessions"], "play-controls");
				liveTavernView.invalidate(sessionId);
				tavernCoordination.invalidate(sessionId);
			}
		}
		function SupersededTurnErrors(props) {
			const marker = React.useRef(null);
			const running = props.useSession(function (snapshot) { return snapshot.running; });
			const latestMessageId = props.useChat(latestTavernAssistantMessageId);
			const state = useLiveTavernView(props.sessionId, "suppression:" + String(latestMessageId || "") + ":" + String(running));
			const play = isPlayMode(state.view && state.view.mode);
			const preferences = React.useSyncExternalStore(displayPreferences.subscribe, displayPreferences.snapshot, displayPreferences.snapshot);
			const hideProcess = play && !(preferences && preferences.showPlayProcess === true);
			const turns = state.view && state.view.suppressedDshErrorTurns || [];
			const hiddenTurns = state.view && state.view.hiddenDshErrorTurns;
			// The failure still owning the tail: its row offers withdraw and rewind.
			const failedTailTurn = state.view && state.view.failedTailTurn !== null && state.view.failedTailTurn !== undefined
				? (state.view.failedTailPersisted === true && Number(state.view.failedTailTurn) === 0 ? 0 : Number(state.view.failedTailTurn))
				: null;
			const staleTurns = state.view && state.view.staleDshErrorTurns || [];
			const filteredStreak = Number(state.view && state.view.filteredFailureStreak) || 0;
			// 右侧「楼层跳转」照页面上真的画出来的楼层画刻度，不再需要正文行计划。
			const canRewind = !!(state.view && state.view.canRegenerate === true);
			const draft = props.useInput(snapshot => snapshot.draft);
			const chatShown = useTavernChatShown(props.sessionId);
			const draftRef = React.useRef(draft);
			draftRef.current = draft;
			const revision = turns.join(",") + ":" + (Array.isArray(hiddenTurns) ? "saved:" + hiddenTurns.join(",") : "local") + ":" + String(failedTailTurn === null ? "" : failedTailTurn)
				+ ":" + staleTurns.join(",") + ":" + filteredStreak + ":" + canRewind;
			// Clearing a failed tail is the first half of both recovery actions.
			async function clearFailedTail() {
				const result = await rpc("rollbackTurn", { expectedTurn: null }, props.sessionId);
				historyProjection.rolledBack(props.sessionId, result && result.view);
				setCandidatePanel(null); setRegenPanel(null); setCandidateGuidePanel(null);
				return result || {};
			}
			function refreshAfterRecovery() {
				notifyTavernDataChanged(["sessions"], "play-controls");
				liveTavernView.invalidate(props.sessionId);
				tavernCoordination.invalidate(props.sessionId);
			}
			React.useEffect(function () {
				const root = chatShown && marker.current && marker.current.closest("[data-conversation-scroll]");
				if (!root) return;
				const projection = createSupersededErrorProjection(root);
				const rail = createStoryFloorRail(root);
				const controls = createTurnErrorControls(root, {
                    sessionId: props.sessionId, storage: window.localStorage, hiddenTurns: hiddenTurns, failedTailTurn: failedTailTurn,
                    onVisible: function (turn) { tavernPlayEvents.emitOnce(props.sessionId + ":" + turn, "native_error", props.sessionId, { nativeTurn: turn }); },
                    onToggle: !Array.isArray(hiddenTurns) ? undefined : async function (turn, hidden) {
                        const result = await rpc("setFailedErrorVisibility", { sessionId: props.sessionId, turn: turn, hidden: hidden });
                        liveTavernView.setView(props.sessionId, result.view);
                    },
                    // Clearing the stacked line only touches the cleared failures;
                    // the tail failure keeps its withdraw and rewind buttons.
                    onRemoveStale: !Array.isArray(hiddenTurns) ? undefined : async function (turns) {
                        const result = await rpc("setAllFailedErrorVisibility", { sessionId: props.sessionId, hidden: true, turns: turns });
                        liveTavernView.setView(props.sessionId, result.view);
                    },
                    staleTurns: staleTurns, filteredStreak: filteredStreak, canRewind: canRewind,
                    onWithdraw: failedTailTurn === null ? undefined : async function () {
                        try { await withdrawFailedTavernTurn(props.sessionId, props.inputActions, draftRef.current); }
                        catch (error) { tavernErrorHub.report("撤回这条输入", error); }
                        finally { refreshAfterRecovery(); }
                    },
                    onRewind: failedTailTurn === null || !canRewind ? undefined : async function () {
                        try {
                            const cleared = await clearFailedTail();
                            const target = Number(cleared.view && cleared.view.rollbackTargetTurn) || null;
                            const result = await rpc("rollbackTurn", { expectedTurn: target }, props.sessionId);
                            historyProjection.rolledBack(props.sessionId, result && result.view);
                            if (result && result.view && result.view.rollbackWarning) tavernErrorHub.report("回退提示", new Error(result.view.rollbackWarning));
                        } catch (error) { tavernErrorHub.report("回退上一轮", error); }
                        finally { refreshAfterRecovery(); }
                    },
                    onError: function (error) { tavernErrorHub.report("保存错误提示状态失败", error); }
                });
				// Only play folds settled work-step rows; card workbenches keep native DSH behavior.
				// The live round keeps its
				// progress, and the error row below owns the one control that brings them back.
				const stepFold = createStepFoldControls(root, { running: running === true, play: hideProcess });
				const apply = function () { projection.apply(turns); controls.apply(); stepFold.apply(); rail.apply(); };
				apply();
				const observer = observeTurnErrorProjection(root, apply);
				return function () { observer.disconnect(); controls.dispose(); stepFold.dispose(); projection.dispose(); rail.dispose(); };
			}, [props.sessionId, revision, running, hideProcess, chatShown]);
			return React.createElement("span", { ref: marker, hidden: true, "data-tavern-error-projection": props.sessionId });
		}
		// @include background-suppression.js
		const pollBackgroundSuppression = createBackgroundSuppressionPoller(rpc);
		function TurnHistoryProjection(props) {
			const running = props.useSession(function (snapshot) { return snapshot.running; });
			const latestMessageId = props.useChat(latestTavernAssistantMessageId);
			const suppressionState = useLiveTavernView(props.sessionId, "suppression:" + String(latestMessageId || "") + ":" + String(running));
			const [backgroundTurns, setBackgroundTurns] = React.useState([]);
			const [backgroundRevision, setBackgroundRevision] = React.useState(0);
			React.useEffect(function () { setBackgroundTurns([]); }, [props.sessionId]);
			React.useEffect(function () {
				function changed(event) { if (event.detail?.sessionId === props.sessionId) setBackgroundRevision(value => value + 1); }
				window.addEventListener("dsh-tavern-background-history-changed", changed);
				return function () { window.removeEventListener("dsh-tavern-background-history-changed", changed); };
			}, [props.sessionId]);
			React.useEffect(function () {
				if (!String(props.sessionId || "").startsWith("background-")) return;
				return pollBackgroundSuppression(props.sessionId, running,
					result => setBackgroundTurns(result.turns || []),
					error => console.warn("后台回退显示刷新失败", error));
			}, [props.sessionId, latestMessageId, running, backgroundRevision]);
			// Background Agent sessions have no row plan: their rolled-back turns hide whole.
			const backgroundTurnsRevision = backgroundTurns.join(",");
			// The row plan decides which rows show (Wiki「设计：transcript-row-plan」).
			// Immutable and keyed by turn: a changed plan is a new object, never serialized here.
			const transcriptTurns = suppressionState.view && suppressionState.view.transcriptTurns || null;
			const transcriptFrom = suppressionState.view ? suppressionState.view.transcriptFrom : null;
			const chatShown = useTavernChatShown(props.sessionId);
			React.useEffect(function () {
				if (!chatShown) return;
				let frame = null;
				function applyProjectionState() {
					frame = null;
					historyProjection.apply(props.sessionId, transcriptTurns ? { turns: transcriptTurns, from: transcriptFrom } : null, backgroundTurns,
						{ regenerating: Boolean(suppressionState.view && suppressionState.view.regenInProgress === true) });
				}
				function scheduleProjection() {
					if (frame === null) frame = window.requestAnimationFrame(applyProjectionState);
				}
				scheduleProjection();
				// Only chat-row mounts and ownership changes matter; streamed prose and
				// composer edits mutate the page every frame and must not re-scan history.
				const rowSelector = "[data-chat-flow-kind], [data-chat-turn], [data-turn-tail]";
				function touchesRows(node) {
					return node.nodeType === 1 && (node.matches(rowSelector) || !!node.querySelector(rowSelector));
				}
				const observer = new window.MutationObserver(function (records) {
					if (records.some(function (record) {
						return record.type === "attributes" || Array.from(record.addedNodes).some(touchesRows) || Array.from(record.removedNodes).some(touchesRows);
					})) scheduleProjection();
				});
				observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-chat-flow-kind", "data-chat-turn", "data-turn-tail"] });
				return function () { observer.disconnect(); if (frame !== null) window.cancelAnimationFrame(frame); };
			}, [props.sessionId, latestMessageId, running, backgroundTurnsRevision, transcriptTurns, transcriptFrom, chatShown]);
			return null;
		}
        const { CandidateQuestion, CandidateGuidePanel, RegenPanel } = createPlayInteractionPanels({
            interactions, useCandidatePanel, useCandidateGuidePanel, useRegenPanel, dismissCandidateError
        });
        const { HeaderItems: TavernHeaderItems } = createTavernHeaderFeature({
            StatusAction: TavernConversationSettingsAction, ExportAction: TavernConversationExportAction,
            openPage: (ctx, id, sessionId) => openTavernSidebarTab(ctx, { type: id }, { sessionId }),
            openWorldbooks: (node, sessionId) => worldBookSwitcherFeature.open(node, sessionId)
        });

		function register(input) {
			const ctx = input.ctx;
			const slots = input.slots;
			installTavernAssetLaunchers(ctx, slots);
			const uiConversation = ctx.get("uiConversation") || ctx.get("conversation");
			const executeSlash = createTavernFrameSlashExecutor(ctx);
            ctx.effect(() => registerTab(ctx.betterSidebar, {
                id: "dsh-tavern:conversation-settings", title: "本局设置", order: 8, single: true,
                component: props => React.createElement(TavernConversationSettingsTab, { sessionId: props.scope.sessionId, sessions: ctx.sessions })
            }), "dsh-tavern: conversation settings tab");
            // Replace shipped host chrome that is noise in the Tavern profile.
            // Same id + lower priority shadows the host entry (lowest renders).
            ctx.effect(() => slots.inject("conversation.session.header.utilities", () => slots.register(
                { name: "conversation.session.header.utilities", id: "dsh-better-sidebar:bottom-toggle", order: 10, priority: -1 },
                () => null
            )), "dsh-tavern: hide bottom panel toggle");
            ctx.effect(() => slots.inject("conversation.session.header.actions", () => slots.register(
                { name: "conversation.session.header.actions", id: "agent-preset", order: -10, priority: -1 },
                () => null
            )), "dsh-tavern: hide host agent-preset label");
            // the host subagent count dropdown is developer chrome in play (the breadcrumb copy is hidden in
            // shell.css). A list slot shadows an id for every session, so the empty entry is registered only while a mounted
            // play session has the debug view off; card sessions and the debug view keep the host entry.
            let playShadowHolds = 0, releasePlayShadow = null;
            function holdPlayShadow() {
                if (playShadowHolds++ === 0) releasePlayShadow = ctx.effect(() => slots.inject("conversation.session.header.actions", () => slots.register(
                    { name: "conversation.session.header.actions", id: "subagent-catalog", order: 10, priority: -1 },
                    () => null
                )), "dsh-tavern: hide host subagent catalog in play");
                return function () { if (--playShadowHolds === 0) { releasePlayShadow(); releasePlayShadow = null; } };
            }
            // on a phone the play top bar is the title and ⋯ only. The
            // context diagnostics hourglass (Better Sidebar) is shadowed like the subagent catalog; the rest is CSS under the class.
            let phoneShadowHolds = 0, releasePhoneShadow = null;
            function holdPhoneShadow() {
                const releaseClass = holdPhonePlayClass();
                if (phoneShadowHolds++ === 0) releasePhoneShadow = ctx.effect(() => slots.inject("conversation.session.header.utilities", () => slots.register(
                    { name: "conversation.session.header.utilities", id: "dsh-better-sidebar:context-diagnostics", order: 20, priority: -1 },
                    () => null
                )), "dsh-tavern: hide context diagnostics in phone play");
                return function () { releaseClass(); if (--phoneShadowHolds === 0) { releasePhoneShadow(); releasePhoneShadow = null; } };
            }
            ctx.effect(() => slots.inject("conversation.session.header.utilities", () => slots.register(
                { name: "conversation.session.header.utilities", id: "dsh-fork-play-chrome", order: -190 },
                function (props) {
                    const owner = ctx.sessions.subagentAddress(props.sessionId)?.parentSessionId || props.sessionId;
                    const play = isPlayMode(useTavernSessionMode(owner));
                    const preferences = React.useSyncExternalStore(displayPreferences.subscribe, displayPreferences.snapshot, displayPreferences.snapshot);
                    const hide = play && !(preferences && preferences.hideContextAndReasoning === false);
                    const phone = usePhoneWidth() && hide;
                    React.useEffect(() => hide ? holdPlayShadow() : undefined, [hide]);
                    React.useEffect(() => phone ? holdPhoneShadow() : undefined, [phone]);
                    return null;
                }
            )), "dsh-tavern: play-only host chrome");
            ctx.effect(() => slots.inject("conversation.session.header.utilities", () => slots.register(
                { name: "conversation.session.header.utilities", id: "open-in-app", order: -10, priority: -1 },
                () => null
            )), "dsh-tavern: hide host open-in-app");
            ctx.effect(() => slots.inject("conversation.session.header.utilities", () => slots.register(
                { name: "conversation.session.header.utilities", id: "session-log-download", order: 0, priority: -1 },
                () => null
            )), "dsh-tavern: hide host session-log-download");
            ctx.effect(() => slots.inject("conversation.session.header.actions", () => slots.register(
                { name: "conversation.session.header.actions", id: "dsh-tavern-immersive", order: 9 },
                () => React.createElement(TavernImmersiveAction)
            )), "dsh-tavern: immersive header action");
            ctx.effect(() => slots.inject("conversation.session.header.utilities", () => slots.register(
                // the ⋯ menu's phone-play readout row (filled by dsh-tavern-ui with the composer's model and context controls).
                { name: "conversation.session.header.utilities", id: "dsh-tavern-header-items", order: 80, children: { "tavern.play.readout": { kind: "list", scope: "session" } } },
                function (props) {
                    const owner = ctx.sessions.subagentAddress(props.sessionId)?.parentSessionId || props.sessionId;
                    const mode = useTavernSessionMode(owner);
                    if (!mode) return null;
                    return React.createElement(TavernHeaderItems, Object.assign({}, props, { ctx: ctx, sessions: ctx.sessions, openStatus: sessionId => openTavernSidebarTab(ctx, { type: "dsh-tavern:status" }, { sessionId }) }));
                }
            )), "dsh-tavern: header items");
			ctx.effect(() => tavernPanelRegistry.onPin(sessionId => openTavernSidebarTab(ctx, { type: "dsh-tavern:status" }, { sessionId })), "dsh-tavern: reveal pinned panels");
			// the status tab stays open in the right sidebar and the composer's guide icon opens it; by default the
			// top bar has no 酒馆状态 button (TAVERN_HEADER_DEFAULT), the owner can add it in 顶栏设置.
			ctx.effect(() => registerTab(ctx.betterSidebar, {
				id: "dsh-tavern:status",
				title: "酒馆状态",
				icon: function (size) { return React.createElement(StatusTabIcon, { sessions: ctx.sessions, size: size || 16 }); },
				order: 7,
				single: true,
				component: function (props) {
					return React.createElement(TavernStatusTab, { sessions: ctx.sessions, uiConversation: uiConversation, sessionId: props.scope.sessionId, executeSlash: executeSlash, openStyleTab: function (type, meta) { openTavernSidebarTab(ctx, { type: type, meta: meta }, { sessionId: props.scope.sessionId }); } });
				}
			}), "dsh-tavern: Better Sidebar status tab");
			ctx.effect(() => ctx.betterSidebar.registerTab({ id: "dsh-tavern:background-tasks", title: "后台任务", order: 7, single: true,
				component: props => React.createElement(TavernBackgroundTasksTab, { sessionId: props.scope.sessionId }) }), "dsh-tavern: background tasks tab");
			ctx.effect(whileTavernDrawsChat(() => slots.inject("conversation.chat.assistant-actions", () => slots.register(
				{ name: "conversation.chat.assistant-actions", id: "dsh-tavern-rollback-to", order: 19, inject: function (sessionId) { return { sessionId: sessionId }; } },
				TavernRollbackToAction
			)), ctx.sessions), "dsh-tavern: rollback-to-turn action");
			ctx.effect(() => slots.inject("conversation.input.dock", () => slots.register(
				{ name: "conversation.input.dock", id: "dsh-tavern-candidate-actions", order: -130, label: "候选项操作" },
				function (props) { return React.createElement(React.Fragment, null,
                    !ctx.sessions.subagentAddress(props.sessionId) && React.createElement(tavernReplyObserverFeature.GamePage, { sessionId: props.sessionId }),
                    React.createElement(CandidateDockActions, Object.assign({}, props, {
					sessions: ctx.sessions,
					executeCompact: function (sessionId) { return ctx.remote.commands.execute(sessionId, "/compact", []); }
				}))); }
			)), "dsh-tavern: candidate dock actions");
			// 故事视图模式下不注册候选项面板（「下一步行动」与「重新生成候选项」）；条目里的失败轮投影只服务 Tavern 聊天行。
			ctx.effect(whileTavernDrawsChat(() => slots.inject("conversation.input.dock", () => slots.register(
				{ name: "conversation.input.dock", id: "dsh-tavern-question", order: -120, label: "下一步行动" },
				function (props) { return React.createElement(React.Fragment, null,
					React.createElement(SupersededTurnErrors, Object.assign({}, props, { key: props.sessionId })),
					React.createElement(TurnHistoryProjection, Object.assign({}, props, { key: "history:" + props.sessionId })),
					React.createElement(CandidateQuestion, Object.assign({}, props, { sessions: ctx.sessions }))
				); }
			)), ctx.sessions), "dsh-tavern: candidate question panel");
			ctx.effect(whileTavernDrawsChat(() => slots.inject("conversation.input.dock", () => slots.register(
				{ name: "conversation.input.dock", id: "dsh-tavern-candidate-guide", order: -115, label: "重新生成候选项" },
				function (props) { return React.createElement(CandidateGuidePanel, props); }
			)), ctx.sessions), "dsh-tavern: candidate guide panel");
			// 长按监听放在常驻会话层：input.dock 在 session/inputState 未就绪时会整棵卸载，不能承载全局手势。
			ctx.effect(() => slots.inject("conversation.session.header.utilities", () => slots.register(
				{ name: "conversation.session.header.utilities", id: "dsh-tavern-send-hold", order: -105, label: "长按发送键重新生成" },
				function (props) { return React.createElement(TavernSendLongPress, { sessionId: props.sessionId }); }
			)), "dsh-tavern: long press send key");
			ctx.effect(() => slots.inject("conversation.input.dock", () => slots.register(
				{ name: "conversation.input.dock", id: "dsh-fork-session-shell", order: -200, label: "会话外壳" },
				function (props) { return React.createElement(React.Fragment, null,
					tavernStageBoundary("舞台", React.createElement(CardStageHost, { key: "stage:" + props.sessionId, sessionId: props.sessionId, executeSlash: executeSlash })),
					// galgame stage view
					tavernStageBoundary("舞台", React.createElement(GalStageHost, { key: "gal:" + props.sessionId, sessionId: props.sessionId, Regenerate: GalRegenerate, Choices: GalChoices, choiceProps: { useChat: props.useChat, useSession: props.useSession, executeSlash: executeSlash, interruptTurn: interruptStageTurn } }))); }
			)), "dsh-tavern: fork session shell");
            ctx.effect(() => slots.inject("conversation.chat.node", () => slots.register({
                name: "conversation.chat.node", key: "manual-compaction", priority: -1
            }, ManualCompactionNodeView)), "dsh-tavern: player compaction result");
            ctx.effect(() => slots.inject("conversation.chat.node", () => slots.register({
                name: "conversation.chat.node", key: "compaction", priority: -1
            }, CompactionNodeView)), "dsh-tavern: player compaction checkpoint");
			ctx.effect(whileTavernDrawsChat(() => slots.inject("conversation.chat.assistant-actions", () => slots.register(
				{ name: "conversation.chat.assistant-actions", id: "dsh-fork-turn-actions", order: 10, inject: function (sessionId) { return { sessionId: sessionId }; } },
				TurnActions
			)), ctx.sessions), "dsh-tavern: latest round actions under the reply");
			ctx.effect(whileTavernDrawsChat(() => slots.inject("conversation.input.overlay", () => slots.register(
				{ name: "conversation.input.overlay", id: "dsh-fork-jump-latest", order: 10, label: "回到最新" },
				function (props) { return React.createElement(ChatJumpLatest, { key: props.sessionId }); }
			)), ctx.sessions), "dsh-tavern: chat jump-to-latest");

			ctx.effect(() => slots.inject("conversation.session.header.utilities", () => slots.register(
				{ name: "conversation.session.header.utilities", id: "dsh-card-stage-toggle", order: 84 },
				function (props) { return tavernStageBoundary("舞台按钮", React.createElement(CardStageToggle, { key: props.sessionId, sessionId: props.sessionId })); }
			)), "dsh-tavern: card stage toggle");
			ctx.effect(() => slots.inject("conversation.session.header.utilities", () => slots.register(
				{ name: "conversation.session.header.utilities", id: "dsh-fork-gal-stage-toggle", order: 83 },
				function (props) { return tavernStageBoundary("舞台按钮", React.createElement(GalStageToggle, { key: props.sessionId, sessionId: props.sessionId })); }
			)), "dsh-tavern: galgame stage toggle");
			// the BGM player's chat placement (bgm-player.js).
			ctx.effect(() => slots.inject("conversation.session.header.utilities", () => slots.register(
				{ name: "conversation.session.header.utilities", id: "dsh-fork-bgm-player", order: 82 },
				function (props) { return tavernStageBoundary("背景音乐", React.createElement(BgmChat, { key: props.sessionId, sessionId: props.sessionId })); }
			)), "dsh-tavern: BGM player");
			ctx.effect(whileTavernDrawsChat(() => slots.inject("conversation.input.dock", () => slots.register(
				{ name: "conversation.input.dock", id: "dsh-tavern-regen", order: -110, label: "重新生成正文" },
				function (props) { return React.createElement(React.Fragment, null, React.createElement(RegenPanel, props), React.createElement(BodyEditPanel, props)); }
			)), ctx.sessions), "dsh-tavern: regen body panel");
		}
		// Fork contract C5: the story service (story/service.js) reuses these flows.
		return Object.freeze({ register: register, storyActions: Object.freeze({ interactions: interactions, historyProjection: historyProjection, refreshDisplay: refreshDisplay }) });
		}
		const playControlsFeature = createPlayControlsFeatureModule();
		const assistantRendererFeature = createTavernAssistantRendererFeatureModule();
