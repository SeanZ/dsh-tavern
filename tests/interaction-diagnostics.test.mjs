// 使用合成数据验证诊断协议与运行行为。
import assert from "node:assert/strict";
import test from "node:test";
import { host } from "./fixtures/frame-runtime-harness.mjs";

test("诊断环的 noteFrameRuntime 只接受白名单数值，DOM 正文不进缓冲；短窗口多包后立即导出可见，重复导出不重复计数", () => {
  // 客户端运行在独立 vm realm，用可控的 Date 注入该 realm。
  let now = 1000;
  const StubDate = new Proxy(Date, {
    get: (target, key) =>
      key === "now" ? () => now : Reflect.get(target, key),
  });
  const clocked = host({ Date: StubDate }).client;
  {
    const doc = {
      visibilityState: "visible",
      hasFocus: () => true,
      activeElement: null,
    };
    const diagnostics = clocked.createInteractionDiagnostics({ document: doc });
    assert.equal(diagnostics.snapshot().pendingFrameRuntime, null);
    diagnostics.noteFrameRuntime({
      kind: "snapshot",
      status: "partial",
      truncated: true,
      visitedNodes: 12,
      visitedChars: 300,
      emittedChars: 120,
      dom: "<b>secret</b>",
      html: "leak",
      consoleEntries: 3,
    });
    diagnostics.noteFrameRuntime({
      kind: "report",
      visitedNodes: "NaN",
      dom: "<i>again</i>",
    });
    now += 30 * 1000;
    diagnostics.noteFrameRuntime({ kind: "report" });
    let exported = diagnostics.snapshot();
    assert.equal(exported.events.length, 1);
    assert.equal(exported.events[0].type, "frame-runtime-summary");
    assert.equal(exported.events[0].snapshots, 1);
    assert.equal(exported.events[0].visitedNodes, 12);
    assert.equal(exported.events[0].partial, 1);
    assert.equal(exported.events[0].maxConsoleEntries, 3);
    assert.deepEqual(
      {
        reports: exported.pendingFrameRuntime.reports,
        snapshots: exported.pendingFrameRuntime.snapshots,
        windowMs: exported.pendingFrameRuntime.windowMs,
      },
      { reports: 2, snapshots: 0, windowMs: 30000 },
      "60 秒窗口内的新计数立即可见",
    );
    assert.deepEqual(
      diagnostics.snapshot().pendingFrameRuntime,
      exported.pendingFrameRuntime,
      "重复导出不改变计数",
    );
    assert.equal(diagnostics.snapshot().events.length, 1);
    assert.doesNotMatch(JSON.stringify(exported), /secret|leak|again|<b>/);
    now += 31 * 1000;
    diagnostics.noteFrameRuntime({ kind: "report", visitedNodes: 5 });
    exported = diagnostics.snapshot();
    assert.equal(exported.events.length, 2);
    assert.equal(
      exported.events[1].reports,
      3,
      "窗口内累计的两次轻量上报和本次",
    );
    assert.equal(exported.events[1].visitedNodes, 5);
    assert.equal(exported.pendingFrameRuntime, null, "汇总入环后 pending 清零");
  }
});
