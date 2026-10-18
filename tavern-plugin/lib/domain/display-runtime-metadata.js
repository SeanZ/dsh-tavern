// 消息 iframe 运行上报里的 DOM 采集元数据（domSnapshot）。
// 它只描述“这一包有没有采 DOM、采到什么程度、碰到哪些预算、属于哪个 iframe 文档、何时采的”，
// 与 receipt 的业务字段无关，也不会改变存档 revision：随 frame 一起进入 display-runtime 侧车。
//
// status 协议：
//   not_collected —— 默认轻量包，没有遍历 body；
//   empty         —— 显式采集，body 没有子节点；
//   complete      —— 显式采集，预算内走完整棵树；
//   partial       —— 显式采集，被预算截断，reasons 列出原因；
//   legacy        —— 旧版上报器（整段 innerHTML 截断）送来的 dom，没有元数据，不冒充当前文档身份与采集时间。
// documentToken 标识采集所属的 iframe 文档；capturedAt 只在显式采集时存在，表示 DOM 本身的采集时间，
// 与 frame.capturedAt（这一包的上报时间）区分。
const STATUSES = Object.freeze([
  "not_collected",
  "empty",
  "complete",
  "partial",
  "legacy",
]);
const REASONS = Object.freeze([
  "nodes",
  "chars",
  "text",
  "attributes",
  "attribute-chars",
  "children",
  "depth",
]);
const LIMIT_KEYS = Object.freeze([
  "maxNodes",
  "maxChars",
  "maxTextChars",
  "maxAttributes",
  "maxAttributeChars",
  "maxChildren",
  "maxDepth",
]);
const COUNTER_GROUPS = Object.freeze({
  visited: ["nodes", "chars", "attributes", "maxDepth"],
  emitted: ["nodes", "text", "attributes", "chars"],
  skipped: [
    "nodes",
    "children",
    "text",
    "attributes",
    "attributeChars",
    "depth",
    "internalScripts",
  ],
});

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.min(1000000000, Math.floor(number))
    : 0;
}

// 时间戳专用：有限、非负、安全整数范围内的毫秒值；不走计数的 1e9 上限。
function timestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) &&
    number > 0 &&
    number <= Number.MAX_SAFE_INTEGER
    ? Math.floor(number)
    : 0;
}

function counters(source, keys) {
  if (!source || typeof source !== "object") return undefined;
  const out = {};
  for (const key of keys) out[key] = count(source[key]);
  return out;
}

function token(value) {
  return typeof value === "string"
    ? value.replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 80)
    : "";
}

export function snapshotCollected(snapshot) {
  const status =
    snapshot && typeof snapshot === "object" ? snapshot.status : undefined;
  return (
    status === "empty" ||
    status === "complete" ||
    status === "partial" ||
    status === "legacy"
  );
}

// 清洗客户端送来的 domSnapshot；dom 非空却没有元数据时视为旧版上报器。
export function sanitizeDomSnapshot(value, dom) {
  const input = value && typeof value === "object" ? value : null;
  const domText = typeof dom === "string" ? dom : "";
  if (!input || !STATUSES.includes(input.status))
    return domText ? { status: "legacy" } : { status: "not_collected" };
  const out = { status: input.status };
  const documentToken = token(input.documentToken);
  if (documentToken) out.documentToken = documentToken;
  if (
    out.status !== "not_collected" &&
    out.status !== "legacy" &&
    timestamp(input.capturedAt)
  )
    out.capturedAt = timestamp(input.capturedAt);
  if (typeof input.reason === "string" && input.reason)
    out.reason = input.reason.slice(0, 64);
  if (Array.isArray(input.reasons)) {
    const reasons = input.reasons.filter((item) => REASONS.includes(item));
    if (reasons.length) out.reasons = reasons;
  }
  if (input.limits && typeof input.limits === "object") {
    out.limits = {};
    for (const key of LIMIT_KEYS) out.limits[key] = count(input.limits[key]);
  }
  for (const group of Object.keys(COUNTER_GROUPS)) {
    const value = counters(input[group], COUNTER_GROUPS[group]);
    if (value) out[group] = value;
  }
  if (input.reports !== undefined) out.reports = count(input.reports);
  if (input.snapshots !== undefined) out.snapshots = count(input.snapshots);
  return out;
}

// 去重比较用的稳定子集：状态、原因、预算、计数、文档身份、采集时间；不含每包递增的 reports/snapshots。
export function comparableDomSnapshot(value) {
  const snapshot = sanitizeDomSnapshot(value, "");
  return {
    status: snapshot.status,
    documentToken: snapshot.documentToken || "",
    capturedAt: snapshot.capturedAt || 0,
    reason: snapshot.reason || "",
    reasons: snapshot.reasons || [],
    limits: snapshot.limits || null,
    visited: snapshot.visited || null,
    emitted: snapshot.emitted || null,
    skipped: snapshot.skipped || null,
  };
}

// 默认轻量包不得覆盖同一 iframe 文档里已有的显式快照：保留旧 dom 与其元数据（含采集时间与文档身份），其余字段取新包。
// 换了文档（token 不同）的轻量包不继承旧快照；旧版 legacy dom 没有身份与时间，同样不延续。
export function preserveCollectedDom(capture, existingFrame) {
  if (!capture || typeof capture !== "object") return capture;
  const incoming = sanitizeDomSnapshot(capture.domSnapshot, capture.dom);
  if (snapshotCollected(incoming)) return capture;
  if (!existingFrame || typeof existingFrame !== "object") return capture;
  const existingSnapshot = sanitizeDomSnapshot(
    existingFrame.domSnapshot,
    existingFrame.dom,
  );
  if (
    !snapshotCollected(existingSnapshot) ||
    existingSnapshot.status === "legacy"
  )
    return capture;
  if (
    !existingSnapshot.documentToken ||
    existingSnapshot.documentToken !== incoming.documentToken
  )
    return capture;
  return {
    ...capture,
    dom: typeof existingFrame.dom === "string" ? existingFrame.dom : "",
    domSnapshot: existingSnapshot,
  };
}
