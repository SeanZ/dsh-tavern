// 使用合成数据验证诊断协议与运行行为。
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import {
  client,
  copy,
  tick,
  collect,
  spyWholeTreeAccess,
  reporterSandbox,
  DEFAULTS,
  CEILING,
} from "./fixtures/frame-runtime-harness.mjs";

test("显式采集按节点/字符/属性/兄弟/深度预算截断，迭代遍历深树不爆栈，不克隆也不整体序列化", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const { document } = dom.window;
  const counts = spyWholeTreeAccess(dom);
  // 海量兄弟：1000 个 li（2000 个节点）。
  const wide = document.createElement("ul");
  for (let i = 0; i < 1000; i++) {
    const li = document.createElement("li");
    li.textContent = "row " + i;
    wide.appendChild(li);
  }
  const siblings = collect(wide, { maxNodes: 5000, maxChildren: 50 });
  assert.equal(siblings.status, "partial");
  assert.deepEqual(siblings.reasons, ["children"]);
  assert.equal(siblings.emitted.nodes, 100, "50 个 li 和各自文本");
  assert.equal(siblings.skipped.children, 950);
  assert.match(siblings.html, /省略 950 个兄弟节点/);
  // 节点预算：先判断再取子节点，visited 严格不超过 maxNodes。
  const nodes = collect(wide, { maxNodes: 300, maxChildren: 1000 });
  assert.equal(nodes.status, "partial");
  assert.deepEqual(nodes.reasons, ["nodes"]);
  assert.equal(nodes.visited.nodes, 300);
  assert.equal(nodes.emitted.nodes, 300);
  assert.ok(nodes.skipped.nodes > 0);
  // 字符预算：输出严格不超过 maxChars。
  const chars = collect(wide, {
    maxNodes: 5000,
    maxChildren: 1000,
    maxChars: 1234,
  });
  assert.equal(chars.status, "partial");
  assert.ok(chars.reasons.includes("chars"));
  assert.equal(chars.html.length, 1234);
  // 超长文本与超长/过多属性：只读到预算长度，属性按上限截断。
  const heavy = document.createElement("div");
  for (let i = 0; i < 50; i++)
    heavy.setAttribute("data-a" + i, i === 0 ? "v".repeat(10000) : "x");
  heavy.textContent = "t".repeat(100000);
  const heavyHolder = document.createElement("div");
  heavyHolder.appendChild(heavy);
  const heavyOnly = collect(heavyHolder, {
    maxTextChars: 100,
    maxAttributes: 4,
    maxAttributeChars: 32,
  });
  assert.equal(heavyOnly.status, "partial");
  assert.deepEqual(heavyOnly.reasons.slice().sort(), [
    "attribute-chars",
    "attributes",
    "text",
  ]);
  assert.equal(heavyOnly.visited.chars, 100);
  assert.equal(heavyOnly.skipped.text, 100000 - 100);
  assert.equal(heavyOnly.emitted.attributes, 4);
  assert.equal(heavyOnly.skipped.attributes, 46);
  assert.equal(heavyOnly.skipped.attributeChars, 10000 - 32);
  assert.match(heavyOnly.html, /data-dsh-snapshot-omitted-attributes="46"/);
  assert.ok(heavyOnly.html.length < 400, String(heavyOnly.html.length));
  // 深树：3000 层嵌套，深度预算触发，不依赖递归栈（jsdom 只在创建时迭代，不移动该树）。
  const deepRoot = document.createElement("section");
  let deep = deepRoot;
  for (let i = 0; i < 3000; i++) {
    const next = document.createElement("div");
    deep.appendChild(next);
    deep = next;
  }
  deep.textContent = "leaf";
  const deepOnly = collect(deepRoot, { maxNodes: 5000, maxDepth: 10 });
  assert.equal(deepOnly.status, "partial");
  assert.deepEqual(deepOnly.reasons, ["depth"]);
  assert.equal(deepOnly.visited.maxDepth, 10);
  assert.equal(deepOnly.visited.nodes, 10);
  assert.match(deepOnly.html, /深度已截断/);
  assert.doesNotMatch(deepOnly.html, /leaf/);
  const deepCeiling = collect(deepRoot, { maxNodes: 5000, maxDepth: 128 });
  assert.equal(deepCeiling.visited.maxDepth, 128);
  // 注入脚本按固定标记过滤；卡片脚本（含带其它 data- 属性的）保留；文本与属性里的标签被转义。
  const holder = document.createElement("div");
  const injected = document.createElement("script");
  injected.setAttribute("data-dsh-tavern-frame", "");
  injected.textContent = "reporter()";
  const cardScript = document.createElement("script");
  cardScript.setAttribute("data-card-probe", "");
  cardScript.textContent = "card()";
  const hostile = document.createElement("p");
  hostile.textContent = "<img src=x onerror=alert(1)>";
  hostile.setAttribute("title", '"><script>alert(2)</script>');
  const artifacts = document.createElement("script");
  artifacts.setAttribute("data-dsh-tavern-host-artifacts", "");
  artifacts.textContent = "artifacts()";
  holder.append(injected, cardScript, hostile, artifacts);
  const rest = collect(holder, {});
  assert.equal(rest.status, "complete");
  assert.equal(rest.skipped.internalScripts, 2);
  assert.doesNotMatch(rest.html, /artifacts\(\)/);
  assert.doesNotMatch(rest.html, /reporter\(\)/);
  assert.match(rest.html, /<script data-card-probe="">card\(\)<\/script>/);
  assert.match(rest.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(
    rest.html,
    /title="&quot;&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt;"/,
  );
  assert.doesNotMatch(rest.html, /<img/);
  assert.equal(
    collect(holder, {}, {}).skipped.internalScripts,
    0,
    "没有标记列表时不过滤任何脚本",
  );
  // 空容器与无根节点都是“明确采集到空 DOM”。
  assert.equal(collect(document.createElement("div"), {}).status, "empty");
  assert.equal(collect(null, {}).status, "empty");
  assert.deepEqual(counts, { cloneNode: 0, innerHTML: 0, outerHTML: 0 });
  // 预算归一化：非法值回落默认，超过硬上限被压回。
  assert.deepEqual(
    copy(
      client.normalizeTavernFrameSnapshotBudget(
        { maxNodes: 1e9, maxChars: -5, maxTextChars: "abc", maxDepth: 0 },
        DEFAULTS,
        CEILING,
      ),
    ),
    { ...DEFAULTS, maxNodes: 5000 },
  );
});

test("默认 load/resize/console/error/network 上报永不读取 body，状态为 not_collected 且带文档身份，日志与错误明细保留", async () => {
  const sandbox = reporterSandbox();
  sandbox.flush();
  assert.equal(sandbox.reports.length, 1);
  assert.equal(sandbox.reports[0].runtime.dom, "");
  assert.deepEqual(sandbox.reports[0].runtime.domSnapshot, {
    status: "not_collected",
    documentToken: "diag-token",
    reports: 1,
    snapshots: 0,
  });
  assert.equal(sandbox.reports[0].requestId, undefined);
  vm.runInContext(
    'console.error("踏上旅程失败", new Error("消息追加失败")); console.log("角色数据已写入")',
    sandbox.context,
  );
  sandbox.emit("error", {
    target: sandbox.innerWindow,
    message: "boom",
    filename: "card.js",
    lineno: 3,
    colno: 4,
  });
  sandbox.emit("error", {
    target: { tagName: "IMG", src: "https://img.example/a.png?x=1" },
  });
  sandbox.emit("unhandledrejection", { reason: new Error("rejected") });
  await vm.runInContext(
    'fetch("https://cards.example/data.json").catch(function(){})',
    sandbox.context,
  );
  await tick();
  sandbox.emit("resize", {});
  sandbox.emit("load", {});
  sandbox.flush();
  const runtime = sandbox.reports.at(-1).runtime;
  assert.equal(runtime.dom, "");
  assert.equal(runtime.domSnapshot.status, "not_collected");
  assert.equal(
    runtime.domSnapshot.capturedAt,
    undefined,
    "轻量包没有 DOM 采集时间",
  );
  assert.equal(runtime.console[0].args[1].message, "消息追加失败");
  assert.match(runtime.console[0].args[1].stack, /消息追加失败/);
  assert.equal(runtime.console[1].args[0], "角色数据已写入");
  assert.deepEqual(
    runtime.errors.map((item) => item.kind),
    ["error", "resource", "unhandledrejection"],
  );
  assert.equal(runtime.errors[0].line, 3);
  assert.equal(runtime.errors[1].url, "https://img.example/a.png");
  assert.equal(runtime.network[0].failed, true);
  assert.equal(runtime.network[0].error, "network down");
  assert.equal(runtime.domSnapshot.reports, 2);
});

test("快照请求只接受父窗口且 token 一致的消息；合法请求按预算回包并带 requestId、文档身份与采集时间", () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="status"><p>生命 10</p><p>金币 3</p></div><script data-dsh-tavern-touch>touch()</script></body></html>',
  );
  const counts = spyWholeTreeAccess(dom);
  const sandbox = reporterSandbox({ body: dom.window.document.body });
  sandbox.flush();
  const baseline = sandbox.reports.length;
  sandbox.emit("message", {
    source: {},
    data: {
      type: "dsh-tavern-frame-snapshot-request",
      token: "diag-token",
      requestId: "forged-source",
    },
  });
  sandbox.emit("message", {
    source: sandbox.parent,
    data: {
      type: "dsh-tavern-frame-snapshot-request",
      token: "other-token",
      requestId: "forged-token",
    },
  });
  sandbox.emit("message", {
    source: sandbox.parent,
    data: {
      type: "dsh-tavern-frame-runtime",
      token: "diag-token",
      requestId: "wrong-type",
    },
  });
  assert.equal(
    sandbox.reports.length,
    baseline,
    "伪造来源/错误 token/其它类型不触发采集",
  );
  assert.deepEqual(counts, { cloneNode: 0, innerHTML: 0, outerHTML: 0 });

  sandbox.emit("message", {
    source: sandbox.parent,
    data: {
      type: "dsh-tavern-frame-snapshot-request",
      token: "diag-token",
      requestId: "req-1",
    },
  });
  const complete = sandbox.reports.at(-1);
  assert.equal(complete.requestId, "req-1");
  assert.equal(complete.runtime.domSnapshot.status, "complete");
  assert.equal(complete.runtime.domSnapshot.documentToken, "diag-token");
  assert.ok(complete.runtime.domSnapshot.capturedAt > 0);
  assert.match(
    complete.runtime.dom,
    /<div id="status"><p>生命 10<\/p><p>金币 3<\/p><\/div>/,
  );
  assert.doesNotMatch(complete.runtime.dom, /touch\(\)/);
  assert.equal(complete.runtime.domSnapshot.snapshots, 1);
  assert.equal(complete.runtime.domSnapshot.emitted.nodes, 5);

  sandbox.emit("message", {
    source: sandbox.parent,
    data: {
      type: "dsh-tavern-frame-snapshot-request",
      token: "diag-token",
      requestId: "req-2",
      budget: { maxNodes: 2 },
    },
  });
  const partial = sandbox.reports.at(-1);
  assert.equal(partial.requestId, "req-2");
  assert.equal(partial.runtime.domSnapshot.status, "partial");
  assert.deepEqual(partial.runtime.domSnapshot.reasons, ["nodes"]);
  assert.equal(partial.runtime.domSnapshot.limits.maxNodes, 2);
  assert.equal(partial.runtime.domSnapshot.visited.nodes, 2);
  assert.deepEqual(counts, { cloneNode: 0, innerHTML: 0, outerHTML: 0 });

  // 持久侧栏页面的默认包同样不采 DOM。
  const persistent = reporterSandbox({ persistent: true });
  persistent.flush();
  assert.equal(persistent.reports.at(-1).runtime.dom, "");
  assert.equal(
    persistent.reports.at(-1).runtime.domSnapshot.status,
    "not_collected",
  );
});

test("runtimeReporting=false 不注入上报器，frame-document 其余运行时保持", () => {
  const html = client.buildTavernFrameDocument({
    content: "<p>x</p>",
    token: "silent",
    runtimeReporting: false,
  });
  assert.doesNotMatch(html, /dsh-tavern-frame-runtime/);
  assert.doesNotMatch(html, /dsh-tavern-frame-snapshot-request/);
  assert.match(html, /dsh-tavern-frame-height/);
  assert.match(html, /data-dsh-tavern-frame-ready/);
});
