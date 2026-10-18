// Small, content-free ring buffer. Deliberately never persisted or uploaded.
function createInteractionDiagnostics(win) {
  const doc = win.document;
  const records = [];
  const limit = 120, lifetime = 10 * 60 * 1000;
  let lastClick = -Infinity, lastError = -Infinity, lastStall = -Infinity;
  function kind(element) {
    if (!element) return "none";
    if (element.closest?.('[data-composer-input="true"]')) return "composer";
    const tag = String(element.tagName || "").toLowerCase();
    return ["input", "textarea", "button", "iframe", "dialog", "body", "html"].includes(tag) ? tag : "other";
  }
  function trim() {
    const cutoff = Date.now() - lifetime;
    while (records.length && (records.length > limit || records[0].at < cutoff)) records.shift();
  }
  function record(type, detail) {
    records.push(Object.assign({ at: Date.now(), type, visible: Boolean(doc) && doc.visibilityState === "visible", focused: Boolean(doc) && typeof doc.hasFocus === "function" && doc.hasFocus(), active: kind(doc && doc.activeElement) }, detail));
    trim();
  }
  // 消息 iframe 运行上报的累计指标：只收白名单里的计数与枚举，正文永远不进环；
  // 每 60 秒最多汇总一条进环；窗口内未汇总的累计以只读 pending 字段随 snapshot()/download 导出，不重复计数。
  const frameRuntimeSummaryInterval = 60 * 1000;
  const frameRuntime = { reports: 0, snapshots: 0, partial: 0, visitedNodes: 0, visitedChars: 0, emittedChars: 0, consoleEntries: 0, errorEntries: 0, since: 0, lastSummaryAt: 0 };
  function count(value) { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0; }
  function frameRuntimeSummary(now) {
    return { windowMs: Math.max(0, now - frameRuntime.since), reports: frameRuntime.reports, snapshots: frameRuntime.snapshots, partial: frameRuntime.partial,
      visitedNodes: frameRuntime.visitedNodes, visitedChars: frameRuntime.visitedChars, emittedChars: frameRuntime.emittedChars,
      maxConsoleEntries: frameRuntime.consoleEntries, maxErrorEntries: frameRuntime.errorEntries };
  }
  function resetFrameRuntime(now) {
    frameRuntime.reports = 0; frameRuntime.snapshots = 0; frameRuntime.partial = 0; frameRuntime.visitedNodes = 0; frameRuntime.visitedChars = 0; frameRuntime.emittedChars = 0;
    frameRuntime.consoleEntries = 0; frameRuntime.errorEntries = 0; frameRuntime.since = now;
  }
  function pendingFrameRuntime() {
    return frameRuntime.reports + frameRuntime.snapshots > 0 ? frameRuntimeSummary(Date.now()) : null;
  }
  function snapshot() {
    trim();
    return { version: 1, retainedMinutes: 10, maxRecords: limit, events: records.map(item => ({ ...item })), pendingFrameRuntime: pendingFrameRuntime() };
  }
  function noteFrameRuntime(input) {
    const now = Date.now();
    if (!frameRuntime.since) frameRuntime.since = now;
    if (input && input.kind === "snapshot") frameRuntime.snapshots += 1; else frameRuntime.reports += 1;
    if (input && input.truncated === true) frameRuntime.partial += 1;
    frameRuntime.visitedNodes += count(input && input.visitedNodes);
    frameRuntime.visitedChars += count(input && input.visitedChars);
    frameRuntime.emittedChars += count(input && input.emittedChars);
    frameRuntime.consoleEntries = Math.max(frameRuntime.consoleEntries, count(input && input.consoleEntries));
    frameRuntime.errorEntries = Math.max(frameRuntime.errorEntries, count(input && input.errorEntries));
    if (frameRuntime.lastSummaryAt && now - frameRuntime.lastSummaryAt < frameRuntimeSummaryInterval) return;
    frameRuntime.lastSummaryAt = now;
    record("frame-runtime-summary", frameRuntimeSummary(now));
    resetFrameRuntime(now);
  }
  function start() {
    const removers = [], timers = new Set();
    function on(target, name, handler) { target.addEventListener(name, handler, true); removers.push(() => target.removeEventListener(name, handler, true)); }
    on(win, "focus", event => { if (event.target === win) record("window-focus"); });
    on(win, "blur", event => { if (event.target === win) record("window-blur"); });
    on(doc, "visibilitychange", () => record("visibility"));
    on(doc, "pointerdown", event => {
      const editor = doc.querySelector('[data-composer-input="true"]');
      if (!editor) return;
      const rect = editor.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
      if (Date.now() - lastClick < 300) return;
      lastClick = Date.now();
      const hit = doc.elementFromPoint(event.clientX, event.clientY);
      record("composer-click", { target: kind(hit), blocked: Boolean(hit && hit !== editor && !editor.contains(hit)), editable: editor.isContentEditable, inert: Boolean(editor.closest('[inert]')), modal: Boolean(doc.querySelector('dialog[open]')), pointerEvents: win.getComputedStyle(editor).pointerEvents === "none" ? "none" : "auto" });
      const timer = win.setTimeout(() => { timers.delete(timer); record("after-click", { composerFocused: doc.activeElement === editor || editor.contains(doc.activeElement) }); }, 150);
      timers.add(timer);
    });
    function error(type) { if (Date.now() - lastError < 1000) return; lastError = Date.now(); record(type); }
    on(win, "error", () => error("page-error"));
    on(win, "unhandledrejection", () => error("unhandled-rejection"));
    let observer;
    try {
      if (win.PerformanceObserver?.supportedEntryTypes?.includes("longtask")) {
        observer = new win.PerformanceObserver(list => {
          const duration = Math.max(0, ...list.getEntries().map(entry => entry.duration));
          if (duration < 250 || Date.now() - lastStall < 5000) return;
          lastStall = Date.now(); record("main-thread-stall", { durationMs: Math.round(duration) });
        });
        observer.observe({ type: "longtask" });
      }
    } catch (_) { /* Unsupported webviews still record focus and clicks. */ }
    record("started");
    return () => { removers.forEach(remove => remove()); timers.forEach(timer => win.clearTimeout(timer)); observer?.disconnect(); };
  }
  function download() {
    const url = win.URL.createObjectURL(new win.Blob([JSON.stringify(snapshot(), null, 2)], { type: "application/json" }));
    const link = doc.createElement("a");
    link.href = url; link.download = "tavern-interaction-diagnostics.json";
    doc.body.appendChild(link); link.click(); link.remove();
    win.setTimeout(() => win.URL.revokeObjectURL(url), 1000);
  }
  return { start, snapshot, download, noteFrameRuntime };
}
