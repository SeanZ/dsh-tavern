		function CandidateAction(props) {
			const [busy, setBusy] = React.useState(false);
			const candidatePanelState = useCandidatePanel();
			const regenPanelState = useRegenPanel();
			const sessionMode = useTavernSessionMode(props.sessionId);
			const frontRunning = props.useSession(function (snapshot) { return snapshot.running === true; });
			const latestMessageId = props.useChat(latestTavernAssistantMessageId);
			const rollbackViewState = useLiveTavernView(props.sessionId, String(frontRunning) + ":" + String(latestMessageId || ""));
			const activityState = useTavernCoordination(props.sessionId, String(frontRunning) + ":" + String(latestMessageId || ""));
			const activity = describeTavernActivity(activityState.view && activityState.view.activity);
			// 只有真正在跑的结算才挡住生成：pending 只是排队信号，结算被关掉或永远等不到
			// 下一次时，它会把按钮永久写成「后台结算中…」（玩家明明没开后台结算）。
			const settlementActive = activity.role === "settlement" && activity.busy === true;
			const canRollback = rollbackViewState.view && (rollbackViewState.view.canRegenerate ?? rollbackViewState.view.canRollback) === true;
            const clearIncomplete = rollbackViewState.view && rollbackViewState.view.canClearIncompleteReply === true;
			// A failure still owning the tail can be withdrawn or handed to the debugger.
			const failedTailTurn = rollbackViewState.view && rollbackViewState.view.failedTailTurn !== null && rollbackViewState.view.failedTailTurn !== undefined
				? Number(rollbackViewState.view.failedTailTurn) : null;
			// foreground and background compaction run in sequence; block generation until both finish.
			const compacting = Boolean(rollbackViewState.view && rollbackViewState.view.contextCompaction && rollbackViewState.view.contextCompaction.operation && rollbackViewState.view.contextCompaction.operation.status === "running");
			React.useEffect(function () {
				if (!compacting) return;
				const timer = window.setInterval(function () { liveTavernView.invalidate(props.sessionId); tavernCoordination.invalidate(props.sessionId); }, 2000);
				return function () {
					window.clearInterval(timer);
					const panel = interactions.candidates.getSnapshot();
					if (panel && panel.sessionId === props.sessionId && panel.phase === "error" && /压缩/.test(String(panel.error || ""))) setCandidatePanel(null);
				};
			}, [compacting, props.sessionId]);
			const candidateTask = activityState.view && activityState.view.task;
			const taskForMessage = candidateTask && candidateTask.kind === "candidate" && candidateTask.input && String(candidateTask.input.messageId || "") === String(props.messageId || "") ? candidateTask : null;
			const taskBusy = !!(taskForMessage && taskForMessage.busy);
			const regenBusy = regenPanelState !== null && regenPanelState.sessionId === props.sessionId && regenPanelState.phase === "loading";
			const [withdrawBusy, setWithdrawBusy] = React.useState(false);
			const draft = props.useInput(snapshot => snapshot.draft);
			const projectedTaskRef = React.useRef("");
			React.useEffect(function () {
				if (!taskForMessage) return;
				const projection = String(taskForMessage.taskId || "") + ":" + String(taskForMessage.version || 0) + ":" + String(taskForMessage.status || "");
				if (projectedTaskRef.current === projection) return;
				projectedTaskRef.current = projection;
				if (taskForMessage.busy) {
					setCandidatePanel({ sessionId: props.sessionId, messageId: props.messageId, phase: "loading", choices: [], error: "" });
					return;
				}
				if (taskForMessage.status === "succeeded" && taskForMessage.result && taskForMessage.result.candidates) {
					setCandidatePanel(readyCandidatePanel(props.sessionId, props.messageId, taskForMessage.result.candidates));
					setCandidateGuidePanel(null);
					return;
				}
				if (taskForMessage.terminal && !candidateErrorDismissed(projection)) {
					setCandidatePanel({ sessionId: props.sessionId, messageId: props.messageId, phase: "error", choices: [], taskKey: projection, error: playerErrorText(taskForMessage.error || "候选生成未完成", { fallback: "候选生成未完成" }) });
				}
			}, [props.sessionId, props.messageId, taskForMessage && taskForMessage.taskId, taskForMessage && taskForMessage.version, taskForMessage && taskForMessage.status]);
			const reconciledActivityRef = React.useRef("");
			React.useEffect(function () {
				if (!activityState.view || activity.busy) return;
				const revision = activity.phase + ":" + String(activityState.view.updatedAt || 0);
				if (reconciledActivityRef.current === revision) return;
				reconciledActivityRef.current = revision;
				// The host list stream already carries running/activity/blank changes; a full
				// session.list rescans every stored Session and cost seconds per turn.
				liveTavernView.invalidate(props.sessionId);
			}, [props.sessionId, activity.phase, activity.busy, activityState.view && activityState.view.updatedAt]);
			async function generate(force, guidance) {
				if (busy || activity.busy) return;
				setBusy(true);
				setCandidatePanel({ sessionId: props.sessionId, messageId: props.messageId, phase: "loading", choices: [], error: "" });
				try {
					await submitCandidateTask(props.sessionId, props.messageId, guidance);
				} catch (err) { tavernErrorHub.report("候选项生成", err); setCandidatePanel({ sessionId: props.sessionId, messageId: props.messageId, phase: "error", choices: [], error: playerErrorText(err, { fallback: "候选生成未完成" }) }); }
				finally { setBusy(false); liveTavernView.invalidate(props.sessionId); tavernCoordination.invalidate(props.sessionId); }
			}
			function regenerationPanelFor(event, phase) {
				const tail = event && event.currentTarget ? event.currentTarget.closest('[data-chat-flow-kind="turn-tail"]') : null;
				return { sessionId: props.sessionId, messageId: props.messageId, phase: phase, guidance: "", text: "", error: "", tail: tail };
			}
			function openRegeneration(event) {
				if (!canRollback || frontRunning || (activity.busy && !settlementActive) || regenBusy) return;
				setCandidatePanel(null);
				setRegenPanel(regenerationPanelFor(event, "input"));
			}
			// Learned from huajiao1998/dsh-tavern-sqlite-v2: a failed or stopped round can also be
			// dropped entirely, not only replayed.
			async function withdrawFailed() {
				if (failedTailTurn === null || frontRunning || withdrawBusy) return;
				setWithdrawBusy(true);
				try { await withdrawFailedTavernTurn(props.sessionId, props.inputActions, draft); }
				catch (err) { tavernErrorHub.report("撤回这条输入", err); }
				finally {
					setWithdrawBusy(false);
					notifyTavernDataChanged(["sessions"], "play-controls");
					liveTavernView.invalidate(props.sessionId);
					tavernCoordination.invalidate(props.sessionId);
				}
			}
			const h = React.createElement;
			const isScript = sessionMode === "script";
			const hasReadyPanel = candidatePanelState !== null && candidatePanelState.sessionId === props.sessionId && candidatePanelState.messageId === props.messageId && candidatePanelState.phase === "ready";
			if (!isPlayMode(sessionMode)) return null;
			// only="choices" in the composer, only="regen" under the latest reply.
			return h(React.Fragment, null,
				props.only === "regen" ? null : h("button", { className: "dsh-tavern-choice-trigger", "data-fork-action": hasReadyPanel ? "choices-again" : "choices", "data-busy": (busy || taskBusy || activity.busy || settlementActive) || undefined, "aria-busy": (busy || taskBusy || activity.busy || settlementActive) || undefined, disabled: busy || taskBusy || activity.busy || settlementActive || regenBusy || compacting, title: compacting ? "正在压缩上下文，完成后可生成候选项" : (busy || taskBusy) ? "正在生成候选项…" : settlementActive ? "当前正文正在后台结算，请等待完成" : (activity.busy ? activity.blockReason : (hasReadyPanel ? "重新生成候选项（可先填写意见）" : (isScript ? "手动生成候选项；由于跟随剧本，只有一个推荐候选项" : "手动生成候选项"))), onClick: function () {
					setRegenPanel(null);
					if (hasReadyPanel) {
						const previous = candidatePanelState;
						setCandidatePanel(null);
						setCandidateGuidePanel({ sessionId: props.sessionId, messageId: props.messageId, phase: "input", error: "", previous: previous });
					} else {
						generate(false);
					}
				} }, settlementActive ? "后台结算中…" : (activity.busy ? activity.label : ((busy || taskBusy) ? "生成中…" : (hasReadyPanel ? "重新生成候选项" : "生成候选项")))),
				props.only !== "choices" ? h("button", { className: "dsh-tavern-choice-trigger", "data-fork-action": "regen", "data-busy": regenBusy || undefined, "aria-busy": regenBusy || undefined, disabled: !canRollback || frontRunning || compacting || (activity.busy && !settlementActive) || regenBusy, title: regenBusy ? "正在重新生成正文…" : compacting ? "正在压缩上下文，请稍候" : !canRollback ? "还没有可重新生成的正文：先发送一条消息，或等这一轮写完" : (settlementActive ? "重新生成将取消当前正文的后台结算" : (activity.busy ? activity.blockReason : "可选择填写意见，再重新生成并替换当前正文")), onClick: openRegeneration }, regenBusy ? "重生成中…" : "重新生成正文") : null,
				props.only !== "choices" && failedTailTurn !== null ? h("button", { className: "dsh-tavern-choice-trigger dsh-tavern-withdraw-failed", disabled: frontRunning || withdrawBusy, title: "清除这一轮：恢复到这一轮开始前，此前的剧情和变量不变，原输入放回输入框", onClick: withdrawFailed }, withdrawBusy ? "撤回中…" : "撤回这条输入") : null,
				props.only !== "choices" && failedTailTurn !== null ? h(TavernDebugButton, { sessionId: props.sessionId, className: "dsh-tavern-choice-trigger", label: "交给调试 Agent" }) : null
			);
		}

		function TavernRollbackAction(props) {
			const [rolling, setRolling] = React.useState(false);
			const regenPanelState = useRegenPanel();
			const frontRunning = props.useSession(function (snapshot) { return snapshot.running === true; });
			const latestMessageId = props.useChat(latestTavernAssistantMessageId);
			const rollbackViewState = useLiveTavernView(props.sessionId, "rollback:" + String(frontRunning) + ":" + String(latestMessageId || ""));
			const activityState = useTavernCoordination(props.sessionId, "rollback:" + String(frontRunning) + ":" + String(latestMessageId || ""));
			const activity = describeTavernActivity(activityState.view && activityState.view.activity);
			// 只有真正在跑的结算才挡住生成：pending 只是排队信号，结算被关掉或永远等不到
			// 下一次时，它会把按钮永久写成「后台结算中…」（玩家明明没开后台结算）。
			const settlementActive = activity.role === "settlement" && activity.busy === true;
			const canRollback = rollbackViewState.view && rollbackViewState.view.canRollback === true;
            const clearIncomplete = rollbackViewState.view && rollbackViewState.view.canClearIncompleteReply === true;
			const regenBusy = regenPanelState !== null && regenPanelState.sessionId === props.sessionId && regenPanelState.phase === "loading";
			const targetTurn = Number(rollbackViewState.view && rollbackViewState.view.rollbackTargetTurn) || 0;
			const targetRound = tavernRoundOrdinal(rollbackViewState.view, targetTurn);
            const targetLabel = targetRound > 0 ? "回退第 " + targetRound + " 轮" : "回退本轮";
			const blocked = rolling || frontRunning || regenBusy || activity.busy || settlementActive;
			async function rollback() {
				if (!canRollback || blocked) return;
				setRolling(true);
				try {
					// 清除未完成回复只删最新一条 AI 正文；回退本轮才删「输入 + 正文」一整轮。
					const result = clearIncomplete
						? await rpc("clearLatestReply", {}, props.sessionId)
						: await rpc("rollbackTurn", { expectedTurn: targetTurn }, props.sessionId);
					if (!clearIncomplete) historyProjection.rolledBack(props.sessionId, result && result.view);
					setCandidatePanel(null);
					setRegenPanel(null);
					setCandidateGuidePanel(null);
					notifyTavernDataChanged(["sessions"], "play-controls");
					if (result && result.view && result.view.rollbackWarning) tavernErrorHub.report("回退提示", new Error(result.view.rollbackWarning));
				} catch (err) {
					tavernErrorHub.report("回退本轮", err);
				} finally { setRolling(false); liveTavernView.invalidate(props.sessionId); tavernCoordination.invalidate(props.sessionId); }
			}
			if (!canRollback) {
                // While a reply is streaming, the surface has no settled target yet; the
                // server's "not in the message stream" reason would wrongly read as permanent.
                const reason = blocked && !rolling ? "正在生成或后台处理中，完成或停止后才能回退" : rollbackViewState.view && rollbackViewState.view.rollbackUnavailableReason;
                return reason ? React.createElement("button", { type: "button", role: "menuitem", disabled: true, className: "dsh-tavern-menu-unavailable", title: reason },
                    React.createElement("span", null, "回退本轮"),
                    React.createElement("small", null, reason.includes("没有可回退") ? "暂无可回退轮次" : reason)) : null;
            }
			return React.createElement("button", { className: "danger", role: "menuitem", disabled: blocked, title: blocked ? "请等待当前生成或后台处理完成后再回退" : clearIncomplete ? "清除未完成回复，保留已完成剧情" : "删除最近一次用户输入和这段 LLM 输出", onClick: rollback }, rolling ? "处理中…" : clearIncomplete ? "清除未完成回复" : targetLabel);
		}

        function TavernUndoRollbackAction(props) {
            const [busy, setBusy] = React.useState(false);
            const running = props.useSession(function (state) { return state.running === true; });
            const live = useLiveTavernView(props.sessionId, "undo:" + String(running));
            const turn = Number(live.view && live.view.undoRollbackTurn) || 0;
			const order = live.view && live.view.displayRoundOrder;
			// The rollback removed the target floor. Its restored ordinal is immediately
			// after the floors that remain, not the sparse native turn saved on the undo point.
			const round = tavernRoundOrdinal(live.view, turn, Array.isArray(order) ? order.length + 1 : turn);
            if (!turn) return null;
            async function undo() {
                if (busy || running) return;
                setBusy(true);
                try {
                    const result = await rpc("undoRollbackTurn", {}, props.sessionId);
                    historyProjection.restored(props.sessionId, result && result.view);
                    setCandidatePanel(null); setRegenPanel(null); setCandidateGuidePanel(null);
                    notifyTavernDataChanged(["sessions"], "play-controls");
                } catch (error) { tavernErrorHub.report("撤销回退", error); }
                finally { setBusy(false); liveTavernView.invalidate(props.sessionId); tavernCoordination.invalidate(props.sessionId); }
            }
            return React.createElement("button", { role: "menuitem", disabled: busy || running, onClick: undo,
                title: "恢复第 " + round + " 轮正文和状态；新的操作会使此恢复点失效" }, busy ? "恢复中…" : "撤销回退（恢复第 " + round + " 轮）");
        }

        // 每轮消息上的「回退到这一轮」：一次删掉它之后的所有轮次，一次撤销即可全部恢复。
        function TavernRollbackToAction(props) {
            const messageId = String(props.messageId || "");
            const liveState = useScopedLiveTavernView(props.sessionId, "rollback-to:" + messageId, [["mode"], ["canRollback"], ["rollbackTargetTurn"], ["displayRoundOrder"], ["forkTurnsByMessageId", messageId]]);
            const [busy, setBusy] = React.useState(false);
            const view = liveState.view;
            const turn = Number(view && view.forkTurnsByMessageId && view.forkTurnsByMessageId[messageId]) || 0;
            const latest = Number(view && view.rollbackTargetTurn) || 0;
			const round = tavernRoundOrdinal(view, turn);
            if (!view || !isPlayMode(view.mode) || view.canRollback !== true || !(turn > 0) || !(latest > turn)) return null;
            async function rollbackTo() {
                if (busy) return;
                if (!await askTavernConfirm("回退到第 " + round + " 轮？\n\n第 " + round + " 轮之后的所有输入和正文都会删除，剧情状态回到第 " + round + " 轮结束时。之后可在菜单里「撤销回退」一次全部恢复。", { confirmText: "回退", cancelText: "取消" })) return;
                setBusy(true);
                try {
                    const result = await rpc("rollbackToTurn", { turn: turn }, props.sessionId);
                    historyProjection.rolledBack(props.sessionId, result && result.view);
                    setCandidatePanel(null); setRegenPanel(null); setCandidateGuidePanel(null);
                    notifyTavernDataChanged(["sessions"], "play-controls");
                    if (result && result.view && result.view.rollbackWarning) tavernErrorHub.report("回退提示", new Error(result.view.rollbackWarning));
                } catch (error) { tavernErrorHub.report("回退到这一轮", error); }
                finally { setBusy(false); liveTavernView.invalidate(props.sessionId); tavernCoordination.invalidate(props.sessionId); }
            }
            const label = busy ? "正在回退…" : "回退到这一轮";
            return React.createElement(DshUi.Tooltip, { label: label, side: "bottom" },
                React.createElement("button", { type: "button", className: "dsh-tavern-message-fork dsh-tavern-message-rollback", "aria-label": label, disabled: busy, onClick: rollbackTo },
                    React.createElement("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
                        React.createElement("path", { d: "M5 5v14" }), React.createElement("path", { d: "M19 12H9m4-5-5 5 5 5" }))));
        }

		const bodyEditPanel = { value: null, listeners: new Set() };
		function setBodyEditPanel(value) {
			bodyEditPanel.value = value;
			bodyEditPanel.listeners.forEach(function (listener) { listener(value); });
		}
		function useBodyEditPanel() {
			const [value, setValue] = React.useState(bodyEditPanel.value);
			React.useEffect(function () { bodyEditPanel.listeners.add(setValue); return function () { bodyEditPanel.listeners.delete(setValue); }; }, []);
			return value;
		}
		function TavernEditBodyAction(props) {
			const [busy, setBusy] = React.useState(false);
			const running = props.useSession(function (snapshot) { return snapshot.running === true; });
			const latestMessageId = props.useChat(latestTavernAssistantMessageId);
			const live = useLiveTavernView(props.sessionId, "edit:" + String(running) + ":" + String(latestMessageId));
			const coordination = useTavernCoordination(props.sessionId, String(running));
			const activity = describeTavernActivity(coordination.view && coordination.view.activity);
			async function openEditor() {
				setBusy(true);
				try {
					const result = await rpc("getBodyEdit", {}, props.sessionId);
					setRegenPanel(null); setCandidatePanel(null); setCandidateGuidePanel(null);
					setBodyEditPanel({ sessionId: props.sessionId, edit: result.edit, texts: result.edit.parts.filter(function (part) { return part.kind === "text"; }).map(function (part) { return part.text; }), busy: false, error: "" });
				} catch (error) { tavernErrorHub.report("编辑正文", error); }
				finally { setBusy(false); }
			}
			if (!live.view || !(live.view.canEditBody ?? live.view.canRollback)) return null;
			return React.createElement("button", { role: "menuitem", disabled: busy || running || activity.busy, onClick: openEditor }, busy ? "读取中…" : "编辑正文");
		}
		function BodyEditPanel(props) {
			const panel = useBodyEditPanel();
			const running = props.useSession(function (snapshot) { return snapshot.running === true; });
			const h = React.createElement;
			// The user-message edit button lives in another feature module; it opens
			// this panel through a page event instead of reaching into this closure.
			React.useEffect(function () {
				function open(event) {
					const detail = event && event.detail ? event.detail : {};
					if (!detail.edit || detail.sessionId !== props.sessionId) return;
					setBodyEditPanel({ sessionId: detail.sessionId, edit: detail.edit, texts: Array.isArray(detail.texts) ? detail.texts : [], busy: false, error: "" });
				}
				window.addEventListener("dsh-tavern-open-body-edit", open);
				return function () { window.removeEventListener("dsh-tavern-open-body-edit", open); };
			}, [props.sessionId]);
			if (!panel || panel.sessionId !== props.sessionId) return null;
			const label = panel.edit.role === "user" ? "编辑这条输入" : "编辑正文";
			const failed = panel.edit.failed === true;
			async function save() {
				setBodyEditPanel(Object.assign({}, panel, { busy: true, error: "" }));
				try {
					let edit = panel.edit, result;
					// Re-read once after a conflict. Story rows must retain their UID;
					// legacy native inputs retain turn+seq. Text equality alone is not identity.
					for (let attempt = 0; ; attempt++) {
						try {
							result = await rpc("saveBodyEdit", { token: edit.token, role: edit.role, index: edit.index, turn: edit.turn, seq: edit.seq, messageIndex: edit.messageIndex, revision: edit.revision, messageUid: edit.messageUid, texts: panel.texts }, props.sessionId);
							break;
						} catch (error) {
							const storyRetry = Number.isSafeInteger(edit.messageIndex);
							const nativeUserRetry = edit.role === "user" && Number.isSafeInteger(Number(edit.turn)) && Number(edit.turn) > 0;
							if (attempt > 0 || (!storyRetry && !nativeUserRetry) || !/正文或会话已变化|输入或会话已变化|剧情已变化/.test(String(error && error.message || error))) throw error;
							let refreshed;
							if (storyRetry) {
								const latest = await rpc("getStoryTranscript", { sessionId: props.sessionId }, props.sessionId);
								const revision = Number(latest && latest.revision !== undefined ? latest.revision : latest && latest.storyTranscript && latest.storyTranscript.revision);
								if (!Number.isSafeInteger(revision) || revision < 0) throw error;
								refreshed = await rpc("getBodyEdit", { role: edit.role, messageIndex: edit.messageIndex, revision: revision, messageUid: edit.messageUid }, props.sessionId);
							} else {
								refreshed = await rpc("getBodyEdit", { role: "user", turn: edit.turn, seq: edit.seq }, props.sessionId);
							}
							if (!refreshed || !refreshed.edit || JSON.stringify(refreshed.edit.parts) !== JSON.stringify(panel.edit.parts)) throw error;
							if (edit.messageUid && refreshed.edit.messageUid !== edit.messageUid) throw error;
							if (!storyRetry && (Number(refreshed.edit.turn) !== Number(edit.turn) || Number(refreshed.edit.seq) !== Number(edit.seq))) throw error;
							edit = refreshed.edit;
						}
					}
					if (result && typeof result.composerText === "string") {
						// A failed turn was withdrawn; hand the edited text back to the composer.
						if (result.view) liveTavernView.setView(props.sessionId, result.view);
						notifyTavernDataChanged(["sessions"], "play-controls");
						tavernCoordination.invalidate(props.sessionId);
						setBodyEditPanel(null);
						window.dispatchEvent(new CustomEvent("dsh-tavern-story-mutated", { detail: { sessionId: props.sessionId } }));
					if (result.composerText.trim() !== "" && props.inputActions && typeof props.inputActions.setDraft === "function") props.inputActions.setDraft(result.composerText);
						return;
					}
					const before = panel.edit.parts.filter(function (part) { return part.kind === "text"; }).map(function (part) { return part.text; }).join("\n");
					const editChars = tavernPlayEvents.editChars(before, panel.texts.join("\n"));
					if (editChars) tavernPlayEvents.emit(panel.edit.role === "user" ? "input_rewrite" : "ai_edit", props.sessionId, { editChars: editChars });
					liveTavernView.setView(props.sessionId, result.view);
					notifyTavernDataChanged(["sessions"], "play-controls");
					tavernCoordination.invalidate(props.sessionId);
					window.dispatchEvent(new CustomEvent("dsh-tavern-story-mutated", { detail: { sessionId: props.sessionId } }));
					setBodyEditPanel(null);
				} catch (error) { setBodyEditPanel(Object.assign({}, panel, { busy: false, error: String(error.message || error) })); }
			}
			let textIndex = 0;
			return h("div", { className: "dsh-tavern-question fork-body-edit", role: "region", "aria-label": label },
				h("div", { className: "dsh-tavern-question-head" }, h("span", null, label)),
				panel.edit.role === "user" ? h("div", { className: "dsh-tavern-question-sub" }, failed
					? "这是失败轮的输入。保存只改文字，不会自动重试；要按新文字重发，先点「撤回这条输入」把它放回输入框，再发送。"
					: "只改这一条输入，不会自动重写已生成的回复；需要新回复时保存后再点「重新生成正文」。") : null,
				panel.error ? h("div", { className: "dsh-tavern-choice-error", role: "alert" }, panel.error) : null,
				h("div", { style: { maxHeight: "50vh", overflowY: "auto" } }, panel.edit.parts.map(function (part, index) {
					if (part.kind === "html") return h("div", { key: index, className: "dsh-tavern-question-sub" }, "HTML 内容保持原样");
					if (part.kind !== "text") return null;
					const current = textIndex++;
					return h("textarea", { key: index, className: "dsh-tavern-regen-input", "aria-label": "正文文本 " + (current + 1), rows: Math.min(60, Math.max(3, panel.texts[current].split("\n").length)), value: panel.texts[current], disabled: panel.busy, onChange: function (event) {
						const texts = panel.texts.slice(); texts[current] = event.target.value;
						setBodyEditPanel(Object.assign({}, panel, { texts: texts }));
					} });
				})),
				h("div", { className: "dsh-tavern-question-foot" },
					h("button", { className: "dsh-tavern-question-primary", disabled: panel.busy || running, onClick: save }, panel.busy ? "保存中…" : "保存"),
					h("button", { className: "dsh-tavern-question-free", disabled: panel.busy, onClick: function () { setBodyEditPanel(null); } }, "取消")));
		}

        // @include modules/background-wait.js

		function TavernStopBackgroundAction(props) {
			const [busy, setBusy] = React.useState(false);
			const state = useTavernCoordination(props.sessionId);
			const activity = state.view && state.view.activity;
			// The game's own background work only: a director runs beside it and is not stopped here.
			if (!activity || (!activity.busy && activity.phase !== "pending")) return null;
			async function stop() {
				if (busy) return;
				setBusy(true);
				try {
					await rpc("stopBackground", { operationId: activity.operationId }, props.sessionId);
					liveTavernView.invalidate(props.sessionId);
					tavernCoordination.invalidate(props.sessionId);
				} catch (error) { tavernErrorHub.report("停止后台", error); }
				finally { setBusy(false); }
			}
			return React.createElement("button", { type: "button", className: "dsh-tavern-choice-trigger", role: props.inMenu ? "menuitem" : undefined, disabled: busy, onClick: stop }, busy ? "正在停止…" : "停止后台");
		}

        // Manual plugin tasks (tavern.manualTask): one button each, run as an exclusive background task.
        function TavernPluginTasks(props) {
            const h = React.createElement;
            const [tasks, setTasks] = React.useState(null);
            const [starting, setStarting] = React.useState("");
            const [error, setError] = React.useState("");
            const running = Boolean(props.activity?.busy && props.activity.role === "plugin-task");
            const load = React.useCallback(async function () {
                try { setTasks((await rpc("listGamePlugins", {}, props.sessionId)).plugins?.tasks || null); }
                catch (_) { /* The game's own controls stay usable. */ }
            }, [props.sessionId]);
            React.useEffect(function () { void load(); }, [load, running]);
            React.useEffect(function () {
                if (!running) return;
                const timer = setInterval(() => { liveTavernView.invalidate(props.sessionId); void load(); }, 2000);
                return () => clearInterval(timer);
            }, [props.sessionId, running, load]);
            if (!tasks || !tasks.manual.length) return null;
            async function start(task, input) {
                await rpc("startPluginTask", { key: task.key, input }, props.sessionId);
                liveTavernView.invalidate(props.sessionId);
                await load();
            }
            async function run(task) {
                if (task.input) {
                    await askTavernText({ title: task.title, description: task.input.label, placeholder: task.input.placeholder, allowEmpty: true, maxLength: 4000, confirmLabel: "开始", onSubmit: input => start(task, input) });
                    return;
                }
                setStarting(task.key); setError("");
                try { await start(task); }
                catch (err) { setError(String(err.message || err)); }
                finally { setStarting(""); }
            }
            return h("section", { className: "dsh-tavern-status-section" },
                h("div", { className: "dsh-tavern-status-label" }, "插件任务"),
                tasks.running ? h("div", { className: "dsh-tavern-status-empty", role: "status" }, "正在运行：" + tasks.running.title + "（插件 " + tasks.running.plugin + "）") : null,
                h("div", { className: "dsh-tavern-plugin-tasks" }, tasks.manual.map(task => h("button", { key: task.key, type: "button", className: "dsh-tavern-btn",
                    title: task.description || "插件 " + task.plugin, disabled: props.busy || running || Boolean(starting), onClick: () => void run(task) }, starting === task.key ? "启动中…" : task.title))),
                error ? h("div", { className: "dsh-card-error", role: "alert" }, error) : null);
        }

		function TavernMoreActions(props) {
			const [open, setOpen] = React.useState(false);
			const [placement, setPlacement] = React.useState(null);
			const root = React.useRef(null);
			const trigger = React.useRef(null);
			const menuRef = React.useRef(null);
			const portalRef = React.useRef(null);
			function closeMenu() {
				const active = document.activeElement;
				if (menuRef.current && menuRef.current.contains(active)) trigger.current?.focus();
				setOpen(false);
			}
			function menuKeys(event) {
				if (event.key === "Tab") { closeMenu(); return; }
				if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
				event.preventDefault();
				const items = Array.from(menuRef.current.querySelectorAll("button:not(:disabled)"));
				if (!items.length) return;
				const index = items.indexOf(document.activeElement);
				const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
				items[next].focus();
			}
			// The mobile composer seat scrolls (overflow-y: auto), which clipped an absolutely
			// positioned menu to a thin strip. Anchor it to the viewport above the trigger instead.
			// When portalled to document.body, fixed positioning is relative to viewport, avoiding
			// parent transform/filter containing block coordinate distortions.
			React.useLayoutEffect(function () {
				if (!open) { setPlacement(null); return; }
				const schemeRoot = trigger.current?.closest("[data-dsh-card-stage-scheme]");
				function syncScheme() {
					if (!portalRef.current) return;
					const scheme = schemeRoot?.getAttribute("data-dsh-card-stage-scheme");
					if (scheme) portalRef.current.setAttribute("data-dsh-card-stage-scheme", scheme);
					else portalRef.current.removeAttribute("data-dsh-card-stage-scheme");
				}
				syncScheme();
				const observer = schemeRoot && typeof MutationObserver !== "undefined" ? new MutationObserver(syncScheme) : null;
				if (observer) observer.observe(schemeRoot, { attributes: true, attributeFilter: ["data-dsh-card-stage-scheme"] });
				function place() {
					const rect = trigger.current && trigger.current.getBoundingClientRect();
					if (!rect) return;
					const width = document.documentElement.clientWidth || window.innerWidth;
					const menuWidth = menuRef.current?.getBoundingClientRect().width || 0;
					const left = Math.max(8, Math.min(rect.right - menuWidth, width - menuWidth - 8)) + "px";
					setPlacement({
						position: "fixed",
						top: "auto",
						left: left,
						right: "auto",
						bottom: (window.innerHeight - rect.top + 6) + "px",
						maxHeight: Math.max(120, rect.top - 12) + "px",
						overflowY: "auto",
						zIndex: 60
					});
				}
				place();
				menuRef.current?.querySelector("button:not(:disabled)")?.focus();
				window.addEventListener("resize", place);
				if (window.visualViewport) window.visualViewport.addEventListener("resize", place);
				return function () { observer?.disconnect(); window.removeEventListener("resize", place); if (window.visualViewport) window.visualViewport.removeEventListener("resize", place); };
			}, [open]);
			React.useEffect(function () {
				if (!open) return;
				function closeOutside(event) {
					if (root.current && root.current.contains(event.target)) return;
					if (menuRef.current && menuRef.current.contains(event.target)) return;
					setOpen(false);
				}
				function closeOnEscape(event) { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); closeMenu(); } }
				document.addEventListener("pointerdown", closeOutside, true);
				document.addEventListener("keydown", closeOnEscape);
				return function () { document.removeEventListener("pointerdown", closeOutside, true); document.removeEventListener("keydown", closeOnEscape); };
			}, [open]);
			const canPortal = typeof ReactDOM !== "undefined" && !!ReactDOM && typeof ReactDOM.createPortal === "function" && typeof document !== "undefined" && !!document.body;
			const menuContent = React.createElement("div", { ref: menuRef, className: "dsh-tavern-more-menu", role: "menu", hidden: !open, style: placement || undefined, onKeyDown: menuKeys, onClick: function (event) { if (event.target && event.target.closest && event.target.closest("button:not(:disabled)")) closeMenu(); } },
				React.createElement(TavernStopBackgroundAction, Object.assign({}, props, { inMenu: true })),
				React.createElement(TavernEditBodyAction, props),
				React.createElement(TavernRollbackAction, props),
				React.createElement(TavernUndoRollbackAction, props),
				React.createElement(TavernDebugButton, { sessionId: props.sessionId, role: "menuitem", label: "遇到问题？交给调试 Agent" }),
				React.createElement(TavernCompactionAction, Object.assign({}, props, { inMenu: true })));
			const renderedMenu = open && canPortal
				? ReactDOM.createPortal(React.createElement("div", { ref: portalRef, className: "dsh-tavern-more-actions", style: { position: "static" } }, menuContent), document.body)
				: (canPortal ? null : menuContent);
			return React.createElement("div", { className: "dsh-tavern-more-actions", ref: root },
				React.createElement("button", { ref: trigger, type: "button", className: "dsh-tavern-choice-trigger", "data-fork-action": "more", title: "更多操作：编辑正文、回退、压缩上下文…", "aria-haspopup": "menu", "aria-expanded": open, onClick: function () { setOpen(function (value) { return !value; }); } }, "更多 ▾"),
				renderedMenu
			);
		}
