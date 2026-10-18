// 使用合成数据验证诊断协议与运行行为。
import assert from "node:assert/strict";
import test from "node:test";
import {
  host,
  tick,
  frames,
  light,
} from "./fixtures/frame-runtime-harness.mjs";

test("宿主 requestRuntimeSnapshot 经既有 frame 通道发请求，回包兑现等待并与同文档轻量包合并后持久化；ready/MVU 分支不变", async () => {
  const h = frames(),
    frame = h.attach();
  frame.message("dsh-tavern-frame-ready");
  const request = h.lifecycle.requestRuntimeSnapshot({
    maxNodes: 10,
    maxChars: 1e9,
    timeoutMs: 5000,
  });
  const sent = h.posts.at(-1);
  assert.equal(sent.type, "dsh-tavern-frame-snapshot-request");
  assert.equal(sent.token, frame.document.token);
  assert.equal(sent.budget.maxNodes, 10);
  assert.equal(
    sent.budget.maxChars,
    100000,
    "超过硬上限的预算在宿主侧就被压回",
  );
  // 伪造的 requestId / 其它文档 token 不兑现。
  frame.message("dsh-tavern-frame-runtime", {
    requestId: "snapshot:999",
    runtime: {
      dom: "<b>forged</b>",
      domSnapshot: { status: "complete", documentToken: frame.document.token },
    },
  });
  h.deliver(frame.node, {
    type: "dsh-tavern-frame-runtime",
    token: "other",
    requestId: sent.requestId,
    runtime: { dom: "x" },
  });
  let settled = false;
  request.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await tick();
  assert.equal(settled, false);
  const token = frame.document.token;
  frame.message("dsh-tavern-frame-runtime", {
    requestId: sent.requestId,
    runtime: {
      capturedAt: 1,
      dom: "<div>状态</div>",
      domSnapshot: {
        status: "partial",
        documentToken: token,
        capturedAt: 1,
        reasons: ["nodes"],
        visited: { nodes: 10, chars: 40 },
        emitted: { chars: 12 },
      },
      console: [],
      errors: [],
      network: [],
    },
  });
  const runtime = await request;
  assert.equal(runtime.domSnapshot.status, "partial");
  // 同一合并窗口内后到的同文档轻量包不得覆盖显式快照，但其它字段取最新包。
  frame.message("dsh-tavern-frame-runtime", {
    runtime: light(token, { console: [{ level: "log", args: ["later"] }] }),
  });
  await h.runTimer((timer) => timer.delay === 1000);
  const capture = h.calls.find(
    (call) => call.method === "captureDisplayRuntime",
  );
  assert.equal(capture.args.runtime.dom, "<div>状态</div>");
  assert.equal(capture.args.runtime.domSnapshot.status, "partial");
  assert.equal(
    capture.args.runtime.domSnapshot.capturedAt,
    1,
    "DOM 采集时间随快照保留",
  );
  assert.equal(
    capture.args.runtime.console[0].args[0],
    "later",
    "其余字段取最新包",
  );
  assert.equal(capture.args.runtime.capturedAt, 2, "包本身的上报时间是新包的");
  assert.equal(capture.args.runtime.layout.mode, "legacy");
  // 宿主侧合并：换了文档 token 的轻量包不继承旧快照。
  const merged = h.client.mergeTavernFrameRuntimeReports(
    {
      dom: "<p>old</p>",
      domSnapshot: { status: "complete", documentToken: "doc-a" },
    },
    light("doc-b"),
  );
  assert.equal(merged.dom, "");
  assert.equal(merged.domSnapshot.status, "not_collected");
  // 诊断环只收到白名单指标。
  assert.deepEqual(
    h.metrics.map((item) => [
      item.kind,
      item.status,
      item.visitedNodes,
      item.truncated,
    ]),
    [
      ["report", "complete", 0, false],
      ["snapshot", "partial", 10, true],
      ["report", "not_collected", 0, false],
    ],
  );
  for (const item of h.metrics)
    assert.ok(Object.values(item).every((value) => typeof value !== "object"));
  // MVU 分支语义不变：独立立即调用，只带 capturedAt 与标志。
  h.respond(() => Promise.resolve({ captured: true }));
  frame.message("dsh-tavern-mvu-view-used");
  await tick();
  const mvu = h.calls.at(-1);
  assert.deepEqual(Object.keys(mvu.args.runtime).sort(), [
    "capturedAt",
    "mvuViewUsed",
  ]);
  assert.deepEqual(h.invalidations, ["A"]);
  // 超时与停止都会拒绝未决请求，不留计时器。
  const timeout = h.lifecycle.requestRuntimeSnapshot({ timeoutMs: 100 });
  await h.runTimer((timer) => timer.delay === 100);
  await assert.rejects(timeout, /超时/);
  const cancelled = h.lifecycle.requestRuntimeSnapshot({});
  h.stop();
  await assert.rejects(cancelled, /已取消/);
  assert.equal(h.timers.size, 0);
});

test("真正替换消息 iframe 后，旧文档 token 的回包被拒绝，旧文档的未决请求随卸载取消", async () => {
  const h = frames(),
    old = h.attach();
  old.message("dsh-tavern-frame-ready");
  const stale = h.lifecycle.requestRuntimeSnapshot({});
  const staleRequestId = h.posts.at(-1).requestId;
  h.update({ content: "<p>replaced</p>" });
  const next = h.attach(h.lifecycle.snapshot().pendingDocument);
  next.message("dsh-tavern-frame-ready");
  assert.equal(h.lifecycle.snapshot().visibleDocument, next.document);
  old.document.ref(null);
  await assert.rejects(stale, /已卸载/);
  // 旧 token 的回包：通道已删除，不兑现、不进入持久化。
  h.deliver(old.node, {
    type: "dsh-tavern-frame-runtime",
    token: old.document.token,
    requestId: staleRequestId,
    runtime: {
      dom: "<p>old</p>",
      domSnapshot: { status: "complete", documentToken: old.document.token },
    },
  });
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls.length, 0);
  h.stop();
});

test("未附着 iframe、runtimeReporting=false 与无会话场景下的请求与上报行为", async () => {
  const detached = frames();
  await assert.rejects(
    detached.lifecycle.requestRuntimeSnapshot({}),
    /尚未就绪/,
  );
  detached.stop();
  const silent = frames({ runtimeReporting: false }),
    silentFrame = silent.attach();
  await assert.rejects(silent.lifecycle.requestRuntimeSnapshot({}), /未启用/);
  silentFrame.message("dsh-tavern-frame-runtime", { runtime: { dom: "x" } });
  assert.equal(silent.timers.size, 0);
  silent.stop();
  // 开场预览等无 sessionId 的 iframe：显式回包仍兑现宿主，但不进入 captureDisplayRuntime。
  const preview = frames({
      sessionId: undefined,
      helperContext: undefined,
      persistent: false,
      turn: 0,
    }),
    previewFrame = preview.attach();
  const request = preview.lifecycle.requestRuntimeSnapshot({});
  previewFrame.message("dsh-tavern-frame-runtime", {
    requestId: preview.posts.at(-1).requestId,
    runtime: { dom: "<i>x</i>", domSnapshot: { status: "complete" } },
  });
  assert.equal((await request).dom, "<i>x</i>");
  assert.equal(preview.calls.length, 0);
  assert.equal(preview.timers.size, 0);
  preview.stop();
});

test("公开入口 tavernUi.captureFrameSnapshot 只命中活着的 frame，按最新轮/指定面板选一个，串行且 stop 后注销", async () => {
  const shared = host();
  const a1 = frames({ turn: 1 }, { host: shared }),
    a1Frame = a1.attach();
  const a2 = frames({ turn: 2, panelId: "status" }, { host: shared }),
    a2Frame = a2.attach();
  const b = frames({ sessionId: "B", turn: 9 }, { host: shared });
  b.attach();
  // 同局注册但尚未 attach 的更高轮：不是活 frame，必须被跳过而不是让采集失败。
  const unattached = frames({ turn: 5 }, { host: shared });
  const service = shared.client.tavernUiService;
  await assert.rejects(service.captureFrameSnapshot({}), /需要 gameId/);
  await assert.rejects(
    service.captureFrameSnapshot({ gameId: "A", turn: -1 }),
    /非负整数/,
  );
  await assert.rejects(
    service.captureFrameSnapshot({ gameId: "C" }),
    /没有挂着/,
  );
  const latest = service.captureFrameSnapshot({
    gameId: "A",
    budget: { maxNodes: 7 },
  });
  await tick();
  const sent = a2.posts.at(-1);
  assert.equal(
    sent.type,
    "dsh-tavern-frame-snapshot-request",
    "未指定轮次时命中当前页面最新的活 frame，跳过未 attach 的第 5 轮",
  );
  assert.equal(unattached.posts.length, 0);
  assert.equal(sent.budget.maxNodes, 7);
  await assert.rejects(service.captureFrameSnapshot({ gameId: "A" }), /进行中/);
  a2Frame.message("dsh-tavern-frame-runtime", {
    requestId: sent.requestId,
    runtime: {
      dom: "",
      domSnapshot: { status: "empty", documentToken: a2Frame.document.token },
    },
  });
  const result = await latest;
  assert.deepEqual(
    {
      gameId: result.gameId,
      turn: result.turn,
      partIndex: result.partIndex,
      panelId: result.panelId,
      status: result.status,
      dom: result.dom,
    },
    {
      gameId: "A",
      turn: 2,
      partIndex: 0,
      panelId: "status",
      status: "empty",
      dom: "",
    },
  );
  const first = service.captureFrameSnapshot({ gameId: "A", turn: 1 });
  await tick();
  a1Frame.message("dsh-tavern-frame-runtime", {
    requestId: a1.posts.at(-1).requestId,
    runtime: {
      dom: "<p>1</p>",
      domSnapshot: {
        status: "complete",
        documentToken: a1Frame.document.token,
      },
    },
  });
  assert.equal((await first).turn, 1);
  a2.stop();
  const afterStop = service.captureFrameSnapshot({ gameId: "A" });
  await tick();
  assert.equal(
    a1.posts.at(-1).type,
    "dsh-tavern-frame-snapshot-request",
    "A 的第 2 轮已注销，回落到仍挂着的第 1 轮",
  );
  a1Frame.message("dsh-tavern-frame-runtime", {
    requestId: a1.posts.at(-1).requestId,
    runtime: {
      dom: "",
      domSnapshot: { status: "empty", documentToken: a1Frame.document.token },
    },
  });
  await afterStop;
  a1.stop();
  b.stop();
  unattached.stop();
  assert.equal(shared.client.tavernFrameRuntimeRegistry.size(), 0);
  await assert.rejects(
    service.captureFrameSnapshot({ gameId: "A" }),
    /没有挂着/,
  );
});

test("30 轮合成生命周期（node 模拟通道）：每轮上报 + 显式快照 + 同轮重生成，捕获归属正确、旧 iframe 请求被取消、无计时器泄漏", async () => {
  // 仅覆盖本任务实现的上报/快照/取消路径，不代表状态栏 ownership 迁移。
  const h = frames();
  for (let turn = 1; turn <= 30; turn++) {
    h.update({ turn, content: "<p>第 " + turn + " 轮</p>" });
    const frame = h.attach(
      h.lifecycle.snapshot().pendingDocument ||
        h.lifecycle.snapshot().visibleDocument,
    );
    frame.message("dsh-tavern-frame-ready");
    assert.equal(h.lifecycle.snapshot().visibleDocument, frame.document);
    for (let i = 0; i < 3; i++)
      frame.message("dsh-tavern-frame-runtime", {
        runtime: light(frame.document.token, { capturedAt: turn * 10 + i }),
      });
    const request = h.lifecycle.requestRuntimeSnapshot({ maxNodes: 50 });
    const requestId = h.posts.at(-1).requestId;
    frame.message("dsh-tavern-frame-runtime", {
      requestId,
      runtime: {
        capturedAt: turn * 100,
        dom: "<p>第 " + turn + " 轮</p>",
        domSnapshot: {
          status: "complete",
          documentToken: frame.document.token,
          capturedAt: turn * 100,
          visited: { nodes: 2 },
        },
      },
    });
    await request;
    frame.message("dsh-tavern-frame-runtime", {
      runtime: light(frame.document.token, { capturedAt: turn * 100 + 1 }),
    });
    await h.runTimer((timer) => timer.delay === 1000);
    // 失败/撤回后同一轮重新生成：旧 iframe 卸载时其未决请求必须被取消，新文档的轻量包不继承旧快照。
    const stale = h.lifecycle.requestRuntimeSnapshot({});
    h.update({ turn, content: "<p>第 " + turn + " 轮 · 重生成</p>" });
    const regenerated = h.attach(h.lifecycle.snapshot().pendingDocument);
    regenerated.message("dsh-tavern-frame-ready");
    frame.document.ref(null);
    await assert.rejects(stale, /已卸载/);
    regenerated.message("dsh-tavern-frame-runtime", {
      runtime: light(regenerated.document.token, {
        capturedAt: turn * 100 + 2,
      }),
    });
    await h.runTimer((timer) => timer.delay === 1000);
  }
  const captures = h.calls.filter(
    (call) => call.method === "captureDisplayRuntime",
  );
  assert.equal(captures.length, 60);
  captures.forEach((call, index) => {
    const turn = Math.floor(index / 2) + 1;
    assert.equal(call.args.turn, turn);
    if (index % 2 === 0) {
      assert.equal(call.args.runtime.dom, "<p>第 " + turn + " 轮</p>");
      assert.equal(call.args.runtime.domSnapshot.status, "complete");
      assert.equal(call.args.runtime.domSnapshot.capturedAt, turn * 100);
      assert.equal(call.args.runtime.capturedAt, turn * 100 + 1);
    } else {
      assert.equal(
        call.args.runtime.dom,
        "",
        "重生成文档的轻量包不冒用旧文档快照",
      );
      assert.equal(call.args.runtime.domSnapshot.status, "not_collected");
    }
  });
  h.stop();
  assert.equal(h.timers.size, 0);
  assert.equal(h.listeners.size, 0);
});

test("旧 token 已开启的合并窗口不丢弃新文档显式快照，也不取消新文档请求", async () => {
  const h = frames({ persistent: false }),
    old = h.attach();
  old.message("dsh-tavern-frame-runtime", {
    runtime: light(old.document.token),
  });
  h.update({ content: "<p>新文档</p>" });
  const next = h.attach(h.lifecycle.snapshot().pendingDocument);
  next.message("dsh-tavern-frame-ready");
  old.document.ref(null);
  const pending = h.lifecycle.requestRuntimeSnapshot({});
  const request = h.posts.at(-1);
  next.message("dsh-tavern-frame-runtime", {
    requestId: request.requestId,
    runtime: {
      capturedAt: 200,
      dom: "<p>新快照</p>",
      domSnapshot: {
        status: "complete",
        documentToken: next.document.token,
        capturedAt: 200,
      },
    },
  });
  assert.equal((await pending).dom, "<p>新快照</p>");
  assert.equal(h.timers.size, 1);
  await h.runTimer((timer) => timer.delay === 1000);
  await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].args.runtime.dom, "<p>新快照</p>");
  assert.equal(
    h.calls[0].args.runtime.domSnapshot.documentToken,
    next.document.token,
  );
  h.stop();
  assert.equal(h.timers.size, 0);
});
