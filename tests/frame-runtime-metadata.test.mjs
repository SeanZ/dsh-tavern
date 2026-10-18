// 使用合成数据验证诊断协议与运行行为。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sanitizeDomSnapshot,
  preserveCollectedDom,
  snapshotCollected,
  comparableDomSnapshot,
} from "../tavern-plugin/lib/domain/display-runtime-metadata.js";
import { createDisplayRuntimeCoalescer } from "../tavern-plugin/lib/domain/display-runtime-coalescer.js";
import { createDisplayRuntimeStore } from "../tavern-plugin/lib/domain/display-runtime-store.js";
import { createProfileDataStore } from "../tavern-plugin/lib/profile-data-store.js";
import { tick } from "./fixtures/frame-runtime-harness.mjs";

test("服务端 domSnapshot 元数据：清洗白名单、旧版 dom 识别、文档身份与采集时间、比较子集稳定", () => {
  assert.deepEqual(sanitizeDomSnapshot(undefined, ""), {
    status: "not_collected",
  });
  assert.deepEqual(sanitizeDomSnapshot(undefined, "<b>old</b>"), {
    status: "legacy",
  });
  assert.deepEqual(sanitizeDomSnapshot({ status: "weird", html: "<x>" }, ""), {
    status: "not_collected",
  });
  assert.deepEqual(
    sanitizeDomSnapshot(
      { status: "not_collected", documentToken: "doc <1>", capturedAt: 5 },
      "",
    ),
    { status: "not_collected", documentToken: "doc1" },
    "轻量包不携带采集时间",
  );
  const cleaned = sanitizeDomSnapshot(
    {
      status: "partial",
      documentToken: "doc-a",
      capturedAt: 1234.9,
      reasons: ["nodes", "bogus"],
      limits: { maxNodes: 5, extra: 1 },
      visited: { nodes: 7.9, chars: -1, html: "x" },
      emitted: { chars: 20 },
      skipped: { children: 3 },
      reports: 2,
      snapshots: 1,
      dom: "<leak>",
    },
    "<p>x</p>",
  );
  assert.deepEqual(cleaned, {
    status: "partial",
    documentToken: "doc-a",
    capturedAt: 1234,
    reasons: ["nodes"],
    limits: {
      maxNodes: 5,
      maxChars: 0,
      maxTextChars: 0,
      maxAttributes: 0,
      maxAttributeChars: 0,
      maxChildren: 0,
      maxDepth: 0,
    },
    visited: { nodes: 7, chars: 0, attributes: 0, maxDepth: 0 },
    emitted: { nodes: 0, text: 0, attributes: 0, chars: 20 },
    skipped: {
      nodes: 0,
      children: 3,
      text: 0,
      attributes: 0,
      attributeChars: 0,
      depth: 0,
      internalScripts: 0,
    },
    reports: 2,
    snapshots: 1,
  });
  assert.equal(snapshotCollected(cleaned), true);
  // DOM 采集时间是现代毫秒时间戳，必须原样保留，不走计数上限。
  const realNow = Date.now();
  assert.equal(
    sanitizeDomSnapshot(
      { status: "complete", documentToken: "doc-A", capturedAt: realNow },
      "<p>x</p>",
    ).capturedAt,
    realNow,
  );
  assert.equal(
    sanitizeDomSnapshot(
      { status: "complete", documentToken: "doc-A", capturedAt: 1792298468474 },
      "<p>x</p>",
    ).capturedAt,
    1792298468474,
  );
  assert.equal(
    sanitizeDomSnapshot(
      { status: "complete", capturedAt: Number.MAX_SAFE_INTEGER + 2 },
      "x",
    ).capturedAt,
    undefined,
  );
  assert.equal(
    sanitizeDomSnapshot({ status: "complete", capturedAt: -5 }, "x").capturedAt,
    undefined,
  );
  // 比较子集忽略每包递增的 reports/snapshots，但区分状态、身份与采集时间。
  assert.deepEqual(
    comparableDomSnapshot({ ...cleaned, reports: 99, snapshots: 7 }),
    comparableDomSnapshot(cleaned),
  );
  assert.notDeepEqual(
    comparableDomSnapshot({
      status: "empty",
      documentToken: "doc-a",
      capturedAt: 1,
    }),
    comparableDomSnapshot({ status: "not_collected", documentToken: "doc-a" }),
  );
  assert.notDeepEqual(
    comparableDomSnapshot({
      status: "complete",
      documentToken: "doc-a",
      capturedAt: 1,
    }),
    comparableDomSnapshot({
      status: "complete",
      documentToken: "doc-a",
      capturedAt: 2,
    }),
  );
  const explicit = {
    capturedAt: 10,
    dom: "<p>快照</p>",
    domSnapshot: { status: "complete", documentToken: "doc-a", capturedAt: 9 },
    mvuViewUsed: true,
    console: [{ level: "log", args: ["old"] }],
  };
  const sameDocument = {
    capturedAt: 20,
    dom: "",
    domSnapshot: { status: "not_collected", documentToken: "doc-a" },
    mvuViewUsed: true,
    console: [{ level: "log", args: ["new"] }],
  };
  const kept = preserveCollectedDom(sameDocument, explicit);
  assert.equal(kept.dom, "<p>快照</p>");
  assert.deepEqual(
    kept.domSnapshot,
    { status: "complete", documentToken: "doc-a", capturedAt: 9 },
    "DOM 采集时间保持为快照时间",
  );
  assert.equal(kept.capturedAt, 20, "包的上报时间是新包的");
  assert.equal(kept.console[0].args[0], "new");
  assert.equal(kept.mvuViewUsed, true);
  assert.equal(
    preserveCollectedDom(
      {
        dom: "",
        domSnapshot: { status: "not_collected", documentToken: "doc-b" },
      },
      explicit,
    ).dom,
    "",
    "新文档的轻量包不把上个文档的快照冒作当前 DOM",
  );
  assert.equal(
    preserveCollectedDom(
      { dom: "", domSnapshot: { status: "not_collected" } },
      explicit,
    ).dom,
    "",
    "没有身份的轻量包不继承",
  );
  assert.equal(
    preserveCollectedDom(sameDocument, { dom: "<p>legacy</p>" }).dom,
    "",
    "旧版整段 dom 不随新包延续",
  );
  assert.equal(
    preserveCollectedDom(sameDocument, {
      dom: "",
      domSnapshot: { status: "empty", documentToken: "doc-a", capturedAt: 3 },
    }).domSnapshot.status,
    "empty",
  );
  assert.equal(
    preserveCollectedDom(
      {
        dom: "<p>新</p>",
        domSnapshot: { status: "partial", documentToken: "doc-a" },
      },
      explicit,
    ).dom,
    "<p>新</p>",
  );
});

test("合并器：显式快照立即落盘并丢弃同 frame 排队中的旧轻量包；旧 timer 触发后不覆盖新快照、日志与 layout", async () => {
  let clock = 0;
  const timers = [],
    writes = [],
    cleared = [];
  const coalescer = createDisplayRuntimeCoalescer({
    intervalMs: 15000,
    now: () => clock,
    setTimer: (fn, ms) => {
      timers.push({ fn, at: clock + ms });
      return timers.length;
    },
    clearTimer: (id) => cleared.push(id),
    write: async (_s, _t, _p, runtime) => {
      writes.push({
        status:
          runtime.domSnapshot?.status || (runtime.mvuViewUsed ? "mvu" : "none"),
        log: runtime.console?.[0],
        layout: runtime.layout,
      });
      return { captured: true };
    },
  });
  const report = (runtime) =>
    coalescer.capture("s", 1, 0, { panelId: "p", ...runtime });
  assert.equal(
    (
      await report({
        domSnapshot: { status: "not_collected" },
        console: ["first"],
        layout: { mode: "content" },
      })
    ).captured,
    true,
  );
  clock = 1000;
  assert.equal(
    (
      await report({
        domSnapshot: { status: "not_collected" },
        console: ["stale"],
        layout: { mode: "content" },
      })
    ).deferred,
    true,
  );
  assert.equal(timers.length, 1);
  clock = 2000;
  assert.equal(
    (
      await report({
        dom: "<p/>",
        domSnapshot: { status: "complete", documentToken: "doc" },
        console: ["snapshot"],
        layout: { mode: "content" },
      })
    ).captured,
    true,
  );
  assert.deepEqual(cleared, [1], "排队中的旧轻量包计时器被取消");
  for (const timer of timers.splice(0)) timer.fn();
  await tick();
  assert.deepEqual(
    writes.map((item) => [item.status, item.log]),
    [
      ["not_collected", "first"],
      ["complete", "snapshot"],
    ],
    "旧包没有被写出",
  );
  // 快照后的新轻量包进入新的 15 秒窗口，带着新日志/layout 延迟写出。
  clock = 3000;
  assert.equal(
    (
      await report({
        domSnapshot: { status: "not_collected", documentToken: "doc" },
        console: ["after"],
        layout: { mode: "content" },
      })
    ).deferred,
    true,
  );
  clock = 20000;
  for (const timer of timers.splice(0)) timer.fn();
  await tick();
  assert.deepEqual(writes.at(-1).log, "after");
  // MVU 即时保存语义保留。
  assert.equal((await report({ mvuViewUsed: true })).captured, true);
});

test("侧车串行临界区：晚到的同文档轻量包不能抹掉刚保存的显式快照，换文档后不继承", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "display-runtime-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createDisplayRuntimeStore({
    store: createProfileDataStore({ dataRoot: root }),
  });
  const frame = (extra) => ({
    partIndex: 0,
    panelId: "status",
    placement: "message",
    ...extra,
  });
  await store.mergeFrame(
    "chat",
    3,
    frame({
      capturedAt: 1,
      dom: "",
      domSnapshot: { status: "not_collected", documentToken: "doc-a" },
    }),
    { reset: true },
  );
  // 显式快照保存，随后两个并发的轻量包（读旧状态时还没有快照）晚写。
  const explicit = store.mergeFrame(
    "chat",
    3,
    frame({
      capturedAt: 2,
      dom: "<p>快照</p>",
      domSnapshot: {
        status: "complete",
        documentToken: "doc-a",
        capturedAt: 2,
      },
      console: [{ level: "log", args: ["x"] }],
    }),
  );
  const lateSame = store.mergeFrame(
    "chat",
    3,
    frame({
      capturedAt: 3,
      dom: "",
      domSnapshot: { status: "not_collected", documentToken: "doc-a" },
      console: [{ level: "log", args: ["late"] }],
    }),
  );
  await Promise.all([explicit, lateSame]);
  let stored = (await store.read("chat", 3)).frames[0];
  assert.equal(stored.dom, "<p>快照</p>");
  assert.deepEqual(stored.domSnapshot, {
    status: "complete",
    documentToken: "doc-a",
    capturedAt: 2,
  });
  assert.equal(stored.capturedAt, 3, "包的上报时间取晚到的轻量包");
  assert.equal(stored.console[0].args[0], "late");
  // 换了 iframe 文档：新文档的轻量包不继承旧快照。
  await store.mergeFrame(
    "chat",
    3,
    frame({
      capturedAt: 4,
      dom: "",
      domSnapshot: { status: "not_collected", documentToken: "doc-b" },
    }),
  );
  stored = (await store.read("chat", 3)).frames[0];
  assert.equal(stored.dom, "");
  assert.deepEqual(stored.domSnapshot, {
    status: "not_collected",
    documentToken: "doc-b",
  });
  // 其它面板不受影响；新回复世代的 reset 从头开始。
  await store.mergeFrame(
    "chat",
    3,
    frame({
      panelId: "other",
      dom: "<i/>",
      domSnapshot: {
        status: "complete",
        documentToken: "doc-c",
        capturedAt: 5,
      },
    }),
  );
  assert.equal((await store.read("chat", 3)).frames.length, 2);
  await store.mergeFrame(
    "chat",
    3,
    frame({
      dom: "",
      domSnapshot: { status: "not_collected", documentToken: "doc-c" },
    }),
    { reset: true, sourceActivityAt: 777 },
  );
  assert.deepEqual(
    (await store.read("chat", 3)).frames.map((item) => [
      item.panelId,
      item.dom,
    ]),
    [["status", ""]],
  );
  // 首次 receipt 竞态：同一回复世代（相同 sourceActivityAt）内并发的 reset:true 写入，不同面板都保留，同 token 快照不被晚到轻量包抹掉。
  const now = Date.now(),
    generation = { reset: true, sourceActivityAt: 500 };
  await Promise.all([
    store.mergeFrame(
      "chat",
      4,
      frame({
        capturedAt: now,
        dom: "<p>A</p>",
        domSnapshot: {
          status: "complete",
          documentToken: "doc-A",
          capturedAt: now,
        },
      }),
      generation,
    ),
    store.mergeFrame(
      "chat",
      4,
      frame({
        partIndex: 1,
        panelId: "b",
        capturedAt: now,
        dom: "<p>B</p>",
        domSnapshot: {
          status: "complete",
          documentToken: "doc-B",
          capturedAt: now,
        },
      }),
      generation,
    ),
    store.mergeFrame(
      "chat",
      4,
      frame({
        capturedAt: now + 1,
        dom: "",
        domSnapshot: { status: "not_collected", documentToken: "doc-A" },
      }),
      generation,
    ),
  ]);
  let frames4 = (await store.read("chat", 4)).frames;
  assert.deepEqual(
    frames4.map((item) => [item.panelId, item.dom]),
    [
      ["status", "<p>A</p>"],
      ["b", "<p>B</p>"],
    ],
  );
  assert.deepEqual(frames4[0].domSnapshot, {
    status: "complete",
    documentToken: "doc-A",
    capturedAt: now,
  });
  // 新回复世代（不同 sourceActivityAt）的 reset：旧回复所有面板清除，同 token 旧 DOM 也不偷偷延续。
  await store.mergeFrame(
    "chat",
    4,
    frame({
      capturedAt: now + 2,
      dom: "",
      domSnapshot: { status: "not_collected", documentToken: "doc-A" },
    }),
    { reset: true, sourceActivityAt: 900 },
  );
  frames4 = (await store.read("chat", 4)).frames;
  assert.deepEqual(
    frames4.map((item) => [item.panelId, item.dom, item.domSnapshot.status]),
    [["status", "", "not_collected"]],
  );
  assert.equal((await store.read("chat", 4)).sourceActivityAt, 900);
});

test("显式快照同样遵守合并器面板数量上限", async () => {
  let at = 0;
  const writes = [];
  const captures = createDisplayRuntimeCoalescer({
    limit: 1,
    now: () => at,
    write: async (_s, _t, _p, runtime) => {
      writes.push(runtime.panelId);
      return { captured: true };
    },
  });
  await captures.capture("s", 1, 0, {
    panelId: "a",
    domSnapshot: { status: "complete" },
  });
  await captures.capture("s", 1, 0, {
    panelId: "b",
    domSnapshot: { status: "complete" },
  });
  at = 1;
  assert.equal(
    (
      await captures.capture("s", 1, 0, {
        panelId: "a",
        domSnapshot: { status: "not_collected" },
      })
    ).captured,
    true,
  );
  assert.deepEqual(writes, ["a", "b", "a"]);
});

test("同页面同世代只拒绝更早整包，等时包按到达顺序，新回复重置优先", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "display-runtime-order-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createDisplayRuntimeStore({
    store: createProfileDataStore({ dataRoot: root }),
  });
  const report = (at, token) => ({
    partIndex: 0,
    panelId: "p",
    capturedAt: at,
    dom: token,
    console: [token],
    domSnapshot: { status: "complete", documentToken: token, capturedAt: at },
  });
  await store.mergeFrame("chat", 1, report(200, "new"), {
    reset: true,
    sourceActivityAt: 1000,
  });
  await store.mergeFrame("chat", 1, report(100, "old"), {
    reset: true,
    sourceActivityAt: 1000,
  });
  assert.equal((await store.read("chat", 1)).frames[0].dom, "new");
  await store.mergeFrame("chat", 1, report(200, "same-time"), {
    sourceActivityAt: 1000,
  });
  assert.equal((await store.read("chat", 1)).frames[0].dom, "same-time");
  await store.mergeFrame("chat", 1, report(50, "next-generation"), {
    reset: true,
    sourceActivityAt: 2000,
  });
  assert.equal((await store.read("chat", 1)).frames[0].dom, "next-generation");
});
