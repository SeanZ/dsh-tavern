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
const BACKGROUND_RUN_STATUS = { queued: "排队中", running: "运行中", completed: "完成", discarded: "已作废", failed: "失败", cancelled: "已取消", skipped: "跳过（功能没开）" };
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
    const [turns, setTurns] = React.useState([]);
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
                setTurns(Array.isArray(result.turns) ? result.turns : []);
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
    return { runs, now, turns, moments, catalog, locks, members };
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
const BACKGROUND_STATUS_MARK = { queued: "…", running: "●", completed: "✓", discarded: "⊘", failed: "✕", cancelled: "⊘", skipped: "–" };
function backgroundClock(time) {
    return new Date(time).toTimeString().slice(0, 8);
}
function backgroundSpan(from, to, now) {
    const seconds = Math.max(0, Math.round(((to || now) - from) / 1000));
    return seconds < 1 ? "" : seconds + " 秒";
}
// One task of a turn: what it is, how it went, the Agent runs it made; click for what it does.
// Under it, the tasks that ran because it finished (任务完成, needs).
function TavernBackgroundTaskNode(props) {
    const h = React.createElement, node = props.node, now = props.now;
    const [open, setOpen] = React.useState(false);
    const memberName = id => backgroundMemberLabel((props.members || []).find(member => member.id === id));
    const info = (props.catalog || []).find(item => item.task === node.task);
    const agent = node.agents[0];
    const facts = node.status === "skipped" ? ["跳过：" + (node.condition ? "只在" + node.condition + "运行" : "功能没开")] : [backgroundSpan((agent && (agent.startedAt || agent.queuedAt)) || node.at, (agent && agent.endedAt) || node.endedAt, now),
        node.agents.map(run => memberName(run.member) || (run.lane === "resident" ? "常驻 Agent" : "临时 Agent")).join("、"),
        agent && agent.model, agent && agent.startedAt && agent.startedAt - agent.queuedAt >= 1000 ? "排队 " + Math.round((agent.startedAt - agent.queuedAt) / 1000) + " 秒" : ""].filter(Boolean);
    return h("li", { className: "dsh-tavern-run-node " + node.status },
        h("button", { type: "button", className: "dsh-tavern-run-node-head", onClick: () => setOpen(!open), "aria-expanded": open,
            title: BACKGROUND_RUN_STATUS[node.status] || node.status },
            h("span", { className: "dsh-tavern-run-mark" }, BACKGROUND_STATUS_MARK[node.status] || "·"),
            h("span", { className: "dsh-tavern-run-name" }, node.name),
            h("span", { className: "dsh-tavern-run-facts" }, facts.join(" · "))),
        node.error ? h("div", { className: "dsh-tavern-run-error" }, node.error) : null,
        node.status === "discarded" ? h("div", { className: "dsh-tavern-run-note" }, "跑完时剧情已变化（回退、重写或编辑），结果没有保存。") : null,
        open ? h("div", { className: "dsh-tavern-run-detail" },
            info ? [["做什么", info.does], ["何时启动", info.trigger], ["读", info.reads], ["写", info.writes], ["等待", info.waits]].filter(([, text]) => text)
                .map(([label, text]) => h("div", { key: label }, h("b", null, label + "："), text)) : h("div", null, "这一项没有登记在任务目录里（它不调用后台 Agent）。"),
            node.agents.map(run => h("div", { key: run.id }, h("b", null, "Agent 运行："),
                (BACKGROUND_RUN_STATUS[run.status] || run.status) + " · " + backgroundClock(run.queuedAt) + (run.error ? " · " + run.error : "")))) : null,
        node.then.length ? h("ul", { className: "dsh-tavern-run-then" }, node.then.map(child => h(TavernBackgroundTaskNode, { ...props, key: child.key, node: child }))) : null);
}
// One turn, like one run of a GitHub Actions workflow: its story moments in order, each with
// the tasks it started.
function TavernBackgroundTurn(props) {
    const h = React.createElement, turn = props.turn;
    const count = list => list.reduce((sum, node) => sum + 1 + count(node.then), 0);
    const flat = list => list.flatMap(node => [node, ...flat(node.then)]);
    const nodes = flat(turn.moments.flatMap(moment => moment.tasks).concat(turn.others));
    const busy = nodes.filter(node => node.status === "running" || node.status === "queued").length;
    const failed = nodes.filter(node => node.status === "failed").length;
    const skipped = nodes.filter(node => node.status === "skipped").length;
    const summary = [count(nodes.filter(node => !nodes.some(other => other.then.includes(node)))) - skipped + " 项任务", skipped ? skipped + " 项跳过" : "", busy ? busy + " 项进行中" : "", failed ? failed + " 项失败" : ""].filter(Boolean).join(" · ");
    const list = tasks => h("ul", { className: "dsh-tavern-run-tasks" }, tasks.map(node => h(TavernBackgroundTaskNode, { key: node.key, node, now: props.now, catalog: props.catalog, members: props.members })));
    return h("details", { className: "dsh-tavern-run-turn", open: props.open },
        h("summary", null, h("b", null, turn.turn ? "第 " + turn.turn + " 轮" : "更早"), " · " + backgroundClock(turn.at) + " · " + summary),
        h("ol", { className: "dsh-tavern-run-moments" },
            turn.moments.map((moment, index) => h("li", { key: moment.event + index },
                h("div", { className: "dsh-tavern-run-moment" }, h("span", null, moment.name), h("time", null, backgroundClock(moment.at))),
                moment.tasks.length ? list(moment.tasks) : null)),
            turn.others.length ? h("li", null,
                h("div", { className: "dsh-tavern-run-moment" }, h("span", null, "手动或插件启动")),
                list(turn.others)) : null));
}
// The 后台任务 sidebar page, for development: per turn, which moment started which task and
// what ran after what; the timeline and the full task list are folded below.
function TavernBackgroundTasksTab(props) {
    const h = React.createElement;
    const { runs, now, turns, moments, catalog, locks, members } = useTavernBackgroundRuns(props.sessionId);
    const active = (runs || []).filter(run => run.status === "queued" || run.status === "running");
    const memberName = id => backgroundMemberLabel(members.find(member => member.id === id));
    return h("aside", { className: "dsh-tavern-status dsh-tavern-status-dashboard dsh-tavern-background-tasks" },
        h("div", { className: "dsh-tavern-status-head" },
            h("div", { className: "dsh-tavern-status-title" }, "后台任务"),
            h("div", { className: "dsh-tavern-status-settle" }, runs === null ? "正在读取…" : backgroundRunsSummary(runs) || "空闲")),
        h("div", { className: "dsh-tavern-status-body" },
            active.length ? h(TavernStopBackgroundAction, { sessionId: props.sessionId }) : null,
            h("section", { className: "dsh-tavern-status-section" },
                h("div", { className: "dsh-tavern-status-label" }, "每轮流程"),
                runs === null ? null : turns.length
                    ? turns.map((turn, index) => h(TavernBackgroundTurn, { key: turn.at, turn, open: index === 0, now, catalog, members }))
                    : h("div", { className: "dsh-tavern-status-empty" }, "服务启动以来这局还没有玩过。"),
                h("p", { className: "dsh-tavern-settings-desc" }, "✓ 完成　● 运行中　… 排队　✕ 失败　⊘ 取消或作废　– 跳过（功能没开）。缩进的任务在上一项做完后才开始；点任务名看它做什么、等什么。只保留重启服务以来的最近几轮。")),
            h("details", { className: "dsh-tavern-status-section dsh-tavern-run-fold" },
                h("summary", null, "时序图（查并发和锁时用）"),
                h("p", { className: "dsh-tavern-settings-desc" }, "每行一个后台 Agent，时间从左到右；浅色是排队，⋯ 是折叠的空闲。「后台锁」行：同一成员的任务同一时间只能跑一个。"),
                runs === null ? null : h(TavernBackgroundTimeline, { runs, moments, now, locks, catalog, members })),
            catalog.length ? h("details", { className: "dsh-tavern-status-section dsh-tavern-run-fold" },
                h("summary", null, "全部任务（" + catalog.length + "）"),
                h("dl", { className: "dsh-tavern-background-catalog" }, catalog.flatMap(item => [
                    h("dt", { key: item.task + ":name", title: item.does }, (item.plugin ? "插件「" + item.plugin + "」" : "") + item.name,
                        h("span", null, memberName(item.member) || (item.lane === "resident" ? "常驻 Agent" : "临时 Agent"))),
                    h("dd", { key: item.task + ":when" }, item.trigger, h("br"), h("span", null, "等待：" + item.waits))])),
                h("p", { className: "dsh-tavern-settings-desc" }, "成员：书记、润色师等是每局常驻的后台 Agent，保留历史；临时 Agent 每次新开，可同时运行。")) : null));
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
