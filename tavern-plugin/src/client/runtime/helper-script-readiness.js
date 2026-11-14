// 初始化就绪只依据已确认的持久化结果；失败使用同一错误通路通知宿主。
			function maybeAnnounceReady() {
				if (!readinessKey || records.size === 0 || announcedReadinessKey === readinessKey) return;
				if (Array.from(records.values()).some(function (record) { return mvuInitializationError(record); })) return;
				if (Array.from(records.values()).some(function (record) { return !record.loaded || record.reloading || (!record.subscriptionsReady && !record.initializationFailed); })) return;
				announcedReadinessKey = readinessKey;
				const readySessionId = activeSessionId;
				const refreshAfterSuppress = suppressedCompactMutations > 0;
				suppressedCompactMutations = 0;
				for (const record of records.values()) record.suppressCompactViewRefresh = false;
				Promise.resolve(onReady(readySessionId)).catch(function (error) { reportError("人物卡脚本初始化", error); });
				if (readySessionId && refreshAfterSuppress) {
					clearPendingMutation(readySessionId);
					notifyMutation(readySessionId, "initialization-ready", null);
				}
			}
			function settleInitialization(record, error, failurePhase) {
				if (record.initializationTimer) hostWindow.clearTimeout(record.initializationTimer);
				record.initializationTimer = null;
				if (error && !record.subscriptionsReady) {
					recordMvuLoadDiagnostic(record, { phase: failurePhase || "initialization-timeout", failureStep: record.mvuLoadState ? "initialization" : "bootstrap", message: String(error.message || error).slice(0, 2000) });
					if (record.scripts.has("__dsh_official_mvu__")) onMvuLoadState({ phase: "error", canRetry: false, error: String(error.message || error) });
					record.initializationFailed = true;
					record.suppressCompactViewRefresh = false;
					const unfinished = Array.from(record.scripts.values()).filter(function (script) { return !script.subscriptionsReady && !script.initializationFailed; });
					for (const script of unfinished) { script.initializationFailed = true; script.initializationError = String(error && error.message || error).slice(0, 4000); }
					const message = String(error && error.message || error || "初始化失败");
					if (message !== record.lastRuntimeError) {
						record.lastRuntimeError = message;
						const source = unfinished.length === 1 ? "人物卡脚本「" + unfinished[0].name + "」" : "人物卡共享脚本沙箱";
						reportError(source, new Error(message));
					}
				}
				maybeAnnounceReady();
			}
			function mvuInitializationError(record) {
				const core = record && record.scripts.get("__dsh_official_mvu__");
				return core && core.initializationFailed ? "MVU 模块加载失败：" + (core.initializationError || "初始化未完成") + "\n请刷新页面或重启酒馆后重试。" : record && record.mvuDataError || "";
			}
            function mvuDataReady(record) {
                // 用户楼层的默认值不能代替开场全部候选的持久初始化回执。
                if (record.context?.openingInitialization?.status === "pending") return false;
                // A blank opening has no floor yet; MVU initializes it in the chat scope.
                const initial = record.context?.chatVariables;
                if (!record.context?.messages?.length) return initial?.stat_data !== undefined && initial?.schema !== undefined;
                const info = applyTavernVariableReceipt.indexApi.info(record.context?.messages);
                return info ? info.eligible > 0 : (record.context?.messages || []).some(message =>
                    message?.variables?.stat_data !== undefined && message?.variables?.schema !== undefined);
            }
			function syncMvuDataReadiness(record) {
				const core = record.scripts.get("__dsh_official_mvu__");
				if (!core || core.initializationFailed || !record.subscriptionsReady) return;
				const ready = mvuDataReady(record);
				if (ready) {
					record.mvuDataError = "";
				}
                // pending initialization writes are not failures merely because they are slow.
				const phase = ready ? "ready" : record.mvuDataError ? "error" : "evaluating";
				if (!record.mvuLoadState || record.mvuLoadState.phase !== phase) {
					recordMvuLoadDiagnostic(record, { phase: ready ? "initialization-ready" : "initialization-waiting", failureStep: "initial-variables" });
					record.mvuLoadState = { phase: phase, canRetry: false, error: record.mvuDataError || "" };
					onMvuLoadState(record.mvuLoadState);
				}
			}

function failMvuInitializationWrite(record, data, error) {
    if (data.eventId || !record.scripts.has("__dsh_official_mvu__") || mvuDataReady(record)
        || !["updateTavernHelperMessages", "updateTavernHelperVariables"].includes(data.method)) return;
    record.mvuDataError = "MVU 初始变量保存失败：" + String(error && error.message || error).slice(0, 2000);
    syncMvuDataReadiness(record);
    recordMvuLoadDiagnostic(record, {phase: "initialization-failed", failureStep: "initial-variables", message: record.mvuDataError});
    notifyMutation(record.sessionId, "initialization-failed", null);
}
