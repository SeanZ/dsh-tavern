function backgroundWaitMessage(progress, now) {
    if (!progress || now - progress.startedAt < 60000) return "";
    const plugin = progress.plugin ? "插件「" + progress.plugin + "」正在结算。" : "";
    return plugin + backgroundPhaseMessage(progress, now);
}
function backgroundPhaseMessage(progress, now) {
    if (progress.phase === "model") {
        return now - progress.lastProgressAt < 15000
            ? "模型仍在输出思考、正文或工具参数，后台任务尚未完成。可以继续等待或停止后台；已生成的正文会保留。"
            : "正在等待模型 API 的有效输出。连续 5 分钟没有有效输出会停止并报错；也可以现在停止后台，保留已生成的正文。";
    }
    return progress.phase === "tool"
        ? "正在执行后台工具或等待人物卡变量处理。若长时间没有完成，可以停止后台；已生成的正文会保留。"
        : "正在准备后台请求。若长时间没有完成，可以停止后台；已生成的正文会保留。";
}
function TavernBackgroundWait(props) {
    const [progress, setProgress] = React.useState(null);
    const [now, setNow] = React.useState(Date.now);
    const active = props.activity?.busy || props.activity?.phase === "pending";
    React.useEffect(function () {
        let disposed = false, loading = false;
        setProgress(null);
        if (!active) return;
        async function refresh() {
            setNow(Date.now());
            if (loading) return;
            loading = true;
            try {
                const result = await rpc("getBackgroundProgress", {}, props.sessionId);
                if (!disposed) setProgress(result.progress);
            } catch (_) { /* Existing task status and stop controls remain usable. */ }
            finally { loading = false; }
        }
        void refresh();
        const timer = window.setInterval(refresh, 5000);
        return function () { disposed = true; window.clearInterval(timer); };
    }, [active, props.sessionId, props.activity?.operationId]);
    const message = backgroundWaitMessage(progress || {phase:"preparing",startedAt:props.activity?.updatedAt || now}, now);
    if (!active || !message) return null;
    return React.createElement("div", {className:"dsh-tavern-status-section", role:"status"},
        React.createElement("p", null, message),
        React.createElement(TavernStopBackgroundAction, {sessionId:props.sessionId}));
}
const BACKGROUND_RUN_TASKS = { polish: "正文精修", settlement: "变量结算", ledger: "手动记账", candidate: "生成选项", "worldbook-filter": "世界书预筛", "style-reference": "文风联想", "stage-director": "舞台导演", phone: "手机", "character-design": "人物设计", subagent: "子任务", edit: "编辑" };
const BACKGROUND_RUN_STATUS = { queued: "排队中", running: "运行中", completed: "完成", discarded: "已作废", failed: "失败", cancelled: "已取消" };
function backgroundRunName(run) {
    return run.task === "plugin" ? "插件「" + (run.plugin || "未知") + "」" : BACKGROUND_RUN_TASKS[run.task] || run.task;
}
function backgroundRunSeconds(run, now) {
    const from = run.startedAt || run.queuedAt, to = run.endedAt || now;
    return Math.max(0, Math.round((to - from) / 1000)) + " 秒";
}
function backgroundRunsSummary(runs) {
    const count = status => runs.filter(run => run.status === status).length;
    return [["running", "运行"], ["queued", "排队"], ["failed", "失败"]].filter(([status]) => count(status)).map(([status, label]) => label + " " + count(status)).join(" · ");
}
// Every background run of this game since the server started, polled while shown.
function useTavernBackgroundRuns(sessionId) {
    const [runs, setRuns] = React.useState(null);
    const [now, setNow] = React.useState(Date.now);
    const [triggers, setTriggers] = React.useState([]);
    React.useEffect(function () {
        let disposed = false, loading = false;
        setRuns(null);
        async function refresh() {
            setNow(Date.now());
            if (loading) return;
            loading = true;
            try {
                const result = await rpc("getBackgroundRuns", {}, sessionId);
                if (disposed) return;
                setRuns(Array.isArray(result.runs) ? result.runs : []);
                setTriggers(Array.isArray(result.triggers) ? result.triggers : []);
            } catch (_) { /* Diagnostic only; the next poll retries. */ }
            finally { loading = false; }
        }
        void refresh();
        const timer = window.setInterval(refresh, 2000);
        return function () { disposed = true; window.clearInterval(timer); };
    }, [sessionId]);
    return { runs, now, triggers };
}
function TavernBackgroundRunRow(props) {
    const h = React.createElement, run = props.run;
    return h("li", { className: "dsh-tavern-background-run " + run.status },
        h("span", { className: "dsh-tavern-background-run-name" }, backgroundRunName(run)),
        h("span", null, BACKGROUND_RUN_STATUS[run.status] || run.status),
        h("span", null, (run.turn ? "第 " + run.turn + " 轮 · " : "") + (run.lane === "resident" ? "常驻" : "临时") + (run.model ? " · " + run.model : "") + " · " + backgroundRunSeconds(run, props.now)),
        run.error ? h("span", { className: "dsh-tavern-background-run-error" }, run.error) : null,
        run.status === "discarded" ? h("span", { className: "dsh-tavern-background-run-note" }, "跑完时剧情已变化（回退、重写或编辑），结果没有保存。") : null);
}
// The 后台任务 sidebar page: what runs and waits now, then what finished recently.
function TavernBackgroundTasksTab(props) {
    const h = React.createElement;
    const { runs, now, triggers } = useTavernBackgroundRuns(props.sessionId);
    const active = (runs || []).filter(run => run.status === "queued" || run.status === "running");
    const done = (runs || []).filter(run => run.status !== "queued" && run.status !== "running");
    const list = (items, empty) => items.length ? h("ol", { className: "dsh-tavern-background-runs" }, items.map(run => h(TavernBackgroundRunRow, { key: run.id, run, now }))) : h("div", { className: "dsh-tavern-status-empty" }, empty);
    return h("aside", { className: "dsh-tavern-status dsh-tavern-status-dashboard dsh-tavern-background-tasks" },
        h("div", { className: "dsh-tavern-status-head" },
            h("div", { className: "dsh-tavern-status-title" }, "后台任务"),
            h("div", { className: "dsh-tavern-status-settle" }, runs === null ? "正在读取…" : backgroundRunsSummary(runs) || "空闲")),
        h("div", { className: "dsh-tavern-status-body" },
            h("section", { className: "dsh-tavern-status-section" },
                h("div", { className: "dsh-tavern-status-label" }, "进行中"),
                list(active, "没有正在运行或排队的后台任务。"),
                active.length ? h(TavernStopBackgroundAction, { sessionId: props.sessionId }) : null),
            h("section", { className: "dsh-tavern-status-section" },
                h("div", { className: "dsh-tavern-status-label" }, "最近完成"),
                list(done, "服务启动以来本局还没有结束的后台任务。")),
            // The story event table: which moment starts or stops which task.
            triggers.length ? h("section", { className: "dsh-tavern-status-section" },
                h("div", { className: "dsh-tavern-status-label" }, "触发关系"),
                h("dl", { className: "dsh-tavern-background-triggers" }, triggers.flatMap(row => [
                    h("dt", { key: row.event + ":name" }, row.name),
                    h("dd", { key: row.event + ":tasks" }, row.followers.length ? row.followers.join("、") : "—")])),
                h("p", { className: "dsh-tavern-settings-desc" }, "变量结算不在表中：正文写完和重新生成时由流程直接启动，并等待它的结果。")) : null,
            h("p", { className: "dsh-tavern-settings-desc" }, "常驻：保留历史的后台 Agent，精修使用独立会话；临时：单独新开的 Agent，可同时运行。记录只保留最近 30 条，重启服务后清空。")));
}
// One line in 酒馆状态 that opens the page.
function TavernBackgroundRunsLink(props) {
    const h = React.createElement;
    const { runs } = useTavernBackgroundRuns(props.sessionId);
    return h("section", { className: "dsh-tavern-status-section dsh-tavern-background-runs-link" },
        h("button", { type: "button", onClick: props.open },
            h("span", { className: "dsh-tavern-status-label" }, "后台任务"),
            h("span", null, (runs && backgroundRunsSummary(runs)) || "空闲"),
            h("span", null, "打开 ↗")));
}
