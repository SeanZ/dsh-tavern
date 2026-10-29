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
const BACKGROUND_RUN_STATUS = { queued: "排队中", running: "运行中", completed: "完成", discarded: "已作废", failed: "失败", cancelled: "已取消" };
function backgroundRunName(run) {
    return run.task === "plugin" ? "插件「" + (run.plugin || "未知") + "」" : run.name || run.task;
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
    const [moments, setMoments] = React.useState([]);
    const [catalog, setCatalog] = React.useState([]);
    const [locks, setLocks] = React.useState([]);
    const [members, setMembers] = React.useState([]);
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
                setMoments(Array.isArray(result.moments) ? result.moments : []);
                setCatalog(Array.isArray(result.catalog) ? result.catalog : []);
                setLocks(Array.isArray(result.locks) ? result.locks : []);
                setMembers(Array.isArray(result.members) ? result.members : []);
            } catch (_) { /* Diagnostic only; the next poll retries. */ }
            finally { loading = false; }
        }
        void refresh();
        const timer = window.setInterval(refresh, 2000);
        return function () { disposed = true; window.clearInterval(timer); };
    }, [sessionId]);
    return { runs, now, triggers, moments, catalog, locks, members };
}
// A development view: one row per background Agent session, time running left to right,
// so which task ran on which Agent, what waited for what and what ran side by side shows.
const TIMELINE_SCALE = 12; // px per second while something runs
const TIMELINE_GAP = 8000; // idle longer than this folds into one break
const TIMELINE_BREAK = 18;
// A plugin's member is shown with its plugin: 插件「npc」·露娜.
function backgroundMemberLabel(member) {
    return member ? (member.plugin ? "插件「" + member.plugin + "」·" : "") + member.name : "";
}
function backgroundTimelineLanes(runs, members) {
    const memberName = id => backgroundMemberLabel((members || []).find(member => member.id === id));
    const lanes = new Map();
    for (const run of runs.slice().sort((a, b) => a.queuedAt - b.queuedAt)) {
        // A resident run still queued has no session yet: it waits on its member's lane.
        const key = run.agentSessionId || (run.lane === "resident" ? "waiting:" + (run.member || "") : run.id);
        if (!lanes.has(key)) lanes.set(key, { key, resident: run.lane === "resident", member: run.member || "", runs: [] });
        lanes.get(key).runs.push(run);
    }
    return [...lanes.values()].map(lane => {
        const names = [...new Set(lane.runs.map(backgroundRunName))];
        const tail = lane.key.startsWith("run-") || lane.key.startsWith("waiting:") ? "" : " …" + lane.key.slice(-4);
        return { ...lane, label: (memberName(lane.member) || (lane.resident ? "常驻" : "临时")) + tail + " · " + names.join("、") };
    }).sort((a, b) => (b.resident - a.resident) || (a.runs[0].queuedAt - b.runs[0].queuedAt));
}
// Busy spans keep their length; idle gaps longer than TIMELINE_GAP fold into a fixed break.
function backgroundTimelineScale(runs, moments, now, locks) {
    const spans = runs.map(run => [run.queuedAt, run.endedAt || now]).concat(moments.map(item => [item.at - 500, item.at + 500]))
        .concat((locks || []).map(item => item.kind === "held" ? [item.from, item.to || now] : [item.at - 500, item.at + 500]))
        .sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [from, to] of spans) {
        const last = merged[merged.length - 1];
        if (last && from - last.to <= TIMELINE_GAP) last.to = Math.max(last.to, to);
        else merged.push({ from, to });
    }
    let offset = 0;
    for (const span of merged) { span.x = offset; offset += (span.to - span.from) / 1000 * TIMELINE_SCALE + TIMELINE_BREAK; }
    const x = time => {
        const span = merged.slice().reverse().find(item => item.from <= time) || merged[0];
        return span ? span.x + Math.max(0, Math.min(time, span.to) - span.from) / 1000 * TIMELINE_SCALE : 0;
    };
    return { x, width: Math.max(0, offset - TIMELINE_BREAK), breaks: merged.slice(1).map(span => span.x - TIMELINE_BREAK / 2), starts: merged };
}
function TavernBackgroundTimeline(props) {
    const h = React.createElement, now = props.now;
    const runs = props.runs || [], since = runs.length ? Math.min(...runs.map(run => run.queuedAt)) - TIMELINE_GAP : 0;
    const moments = (props.moments || []).filter(item => item.at >= since);
    const locks = (props.locks || []).filter(item => (item.from || item.at) >= since);
    if (!runs.length) return h("div", { className: "dsh-tavern-status-empty" }, "还没有后台运行。");
    const lanes = backgroundTimelineLanes(runs, props.members), scale = backgroundTimelineScale(runs, moments, now, locks);
    const roleName = role => role === "plugin-task" ? "插件任务" : (props.catalog || []).find(item => item.task === role)?.name || role;
    const clock = time => new Date(time).toTimeString().slice(0, 8);
    const block = run => {
        const start = run.startedAt || now, end = run.endedAt || now;
        const title = backgroundRunName(run) + " · " + (BACKGROUND_RUN_STATUS[run.status] || run.status) + (run.turn ? " · 第 " + run.turn + " 轮" : "") +
            (run.model ? " · " + run.model : "") + "\n排队 " + Math.round((start - run.queuedAt) / 1000) + " 秒，运行 " + Math.round((end - start) / 1000) + " 秒" + (run.error ? "\n" + run.error : "");
        return [
            start > run.queuedAt ? h("div", { key: run.id + ":wait", className: "dsh-tavern-timeline-wait", style: { left: scale.x(run.queuedAt), width: Math.max(2, scale.x(start) - scale.x(run.queuedAt)) }, title }) : null,
            run.startedAt ? h("div", { key: run.id, className: "dsh-tavern-timeline-run " + run.status, style: { left: scale.x(start), width: Math.max(4, scale.x(end) - scale.x(start)) }, title },
                backgroundRunName(run) + (run.turn ? " #" + run.turn : "")) : null];
    };
    return h("div", { className: "dsh-tavern-timeline" },
        h("div", { className: "dsh-tavern-timeline-inner", style: { width: scale.width + 150 } },
            h("div", { className: "dsh-tavern-timeline-row dsh-tavern-timeline-axis" },
                h("div", { className: "dsh-tavern-timeline-label" }, "时间"),
                h("div", { className: "dsh-tavern-timeline-track" },
                    scale.starts.map(span => h("span", { key: span.from, style: { left: span.x } }, clock(span.from))),
                    moments.map((item, index) => h("span", { key: "m" + index, className: "dsh-tavern-timeline-moment-label", style: { left: scale.x(item.at) } }, "▼" + item.name)))),
            // Each member's slot in the coordinator: who held it, and who was turned away.
            [...new Set(locks.map(item => item.slot || "background"))].map(slot => h("div", { key: "lock:" + slot, className: "dsh-tavern-timeline-row dsh-tavern-timeline-lock" },
                h("div", { className: "dsh-tavern-timeline-label", title: "这个成员的任务同一时间只能跑一个" }, ((props.members || []).find(member => member.id === slot)?.name || slot) + "的后台锁"),
                h("div", { className: "dsh-tavern-timeline-track" }, locks.filter(item => (item.slot || "background") === slot).map((item, index) => item.kind === "held"
                    ? h("div", { key: index, className: "dsh-tavern-timeline-run held", style: { left: scale.x(item.from), width: Math.max(4, scale.x(item.to || now) - scale.x(item.from)) },
                        title: roleName(item.role) + " 占用 " + Math.round(((item.to || now) - item.from) / 1000) + " 秒" + (item.status ? "（" + item.status + "）" : "") }, roleName(item.role))
                    : h("i", { key: index, className: "dsh-tavern-timeline-refused", style: { left: scale.x(item.at) },
                        title: roleName(item.role) + " 被挡回：" + roleName(item.holder) + " 正占用" }, "✕"))))),
            lanes.map(lane => h("div", { key: lane.key, className: "dsh-tavern-timeline-row" },
                h("div", { className: "dsh-tavern-timeline-label", title: lane.key }, lane.label),
                h("div", { className: "dsh-tavern-timeline-track" }, lane.runs.flatMap(block)))),
            h("div", { className: "dsh-tavern-timeline-overlay", style: { width: scale.width } },
                moments.map((item, index) => h("i", { key: index, className: "dsh-tavern-timeline-moment", style: { left: scale.x(item.at) } })),
                scale.breaks.map((left, index) => h("i", { key: "b" + index, className: "dsh-tavern-timeline-break", style: { left } })))));
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
    const { runs, now, triggers, moments, catalog, locks, members } = useTavernBackgroundRuns(props.sessionId);
    const active = (runs || []).filter(run => run.status === "queued" || run.status === "running");
    const done = (runs || []).filter(run => run.status !== "queued" && run.status !== "running");
    const list = (items, empty) => items.length ? h("ol", { className: "dsh-tavern-background-runs" }, items.map(run => h(TavernBackgroundRunRow, { key: run.id, run, now }))) : h("div", { className: "dsh-tavern-status-empty" }, empty);
    return h("aside", { className: "dsh-tavern-status dsh-tavern-status-dashboard dsh-tavern-background-tasks" },
        h("div", { className: "dsh-tavern-status-head" },
            h("div", { className: "dsh-tavern-status-title" }, "后台任务"),
            h("div", { className: "dsh-tavern-status-settle" }, runs === null ? "正在读取…" : backgroundRunsSummary(runs) || "空闲")),
        h("div", { className: "dsh-tavern-status-body" },
            h("section", { className: "dsh-tavern-status-section" },
                h("div", { className: "dsh-tavern-status-label" }, "时序（每行一个后台 Agent，浅色为排队，⋯ 为折叠的空闲）"),
                runs === null ? null : h(TavernBackgroundTimeline, { runs, moments, now, locks, catalog, members })),
            h("section", { className: "dsh-tavern-status-section" },
                h("div", { className: "dsh-tavern-status-label" }, "进行中"),
                list(active, "没有正在运行或排队的后台任务。"),
                active.length ? h(TavernStopBackgroundAction, { sessionId: props.sessionId }) : null),
            h("section", { className: "dsh-tavern-status-section" },
                h("div", { className: "dsh-tavern-status-label" }, "最近完成"),
                list(done, "服务启动以来本局还没有结束的后台任务。")),
            // Every kind of background task: what it does, which Agent runs it, what starts it.
            catalog.length ? h("section", { className: "dsh-tavern-status-section" },
                h("div", { className: "dsh-tavern-status-label" }, "任务目录"),
                h("dl", { className: "dsh-tavern-background-catalog" }, catalog.flatMap(item => [
                    h("dt", { key: item.task + ":name" }, (item.plugin ? "插件「" + item.plugin + "」" : "") + item.name, h("span", null, backgroundMemberLabel(members.find(member => member.id === item.member)) || (item.lane === "resident" ? "常驻" : "临时"))),
                    h("dd", { key: item.task + ":does" }, item.does,
                        [["何时启动", item.trigger], ["读", item.reads], ["写", item.writes], ["等待", item.waits]].filter(([, text]) => text)
                            .map(([label, text]) => h(React.Fragment, { key: label }, h("br"), h("span", null, label + "：" + text))),
                        item.lock ? h(React.Fragment, null, h("br"), h("span", null, "占用" + (members.find(member => member.id === (item.plugin ? "background" : item.member || "background"))?.name || "") + "的后台锁：与同一成员的其他任务不能同时运行")) : null)]))) : null,
            // The story event table: which moment starts or stops which task.
            triggers.length ? h("section", { className: "dsh-tavern-status-section" },
                h("div", { className: "dsh-tavern-status-label" }, "触发关系"),
                h("dl", { className: "dsh-tavern-background-triggers" }, triggers.flatMap(row => [
                    h("dt", { key: row.event + ":name" }, row.name),
                    h("dd", { key: row.event + ":tasks" }, row.followers.length ? row.followers.join("、") : "—")])),
                h("p", { className: "dsh-tavern-settings-desc" }, "标「流程启动」的任务由回复流程自己启动并等待结果，这里只列出它。")) : null,
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
