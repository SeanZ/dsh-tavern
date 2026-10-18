import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { heightReporter } from "./fixtures/frame-height-performance.mjs";

async function harness(t, { raf = true } = {}) {
  const dom = new JSDOM(
    '<body style="margin:0"><div style="overflow:hidden"><span>正文</span></div></body>',
    { runScripts: "outside-only" },
  );
  t.after(() => dom.window.close());
  const win = dom.window,
    doc = win.document,
    frames = [],
    posts = [];
  const parent = { innerHeight: 844, postMessage: (data) => posts.push(data) };
  Object.defineProperty(win, "parent", { value: parent });
  const enqueue = (callback) => {
    frames.push(callback);
    return frames.length;
  };
  if (raf) win.requestAnimationFrame = enqueue;
  else {
    win.setTimeout = enqueue;
    win.clearTimeout = () => {};
  }
  // 即使平台没有成功取消旧帧，generation 也必须拒绝旧任务。
  win.cancelAnimationFrame = () => {};
  const reads = new Map(),
    styleReads = new Map();
  const nativeStyle = win.getComputedStyle;
  win.getComputedStyle = (node) => {
    styleReads.set(node, (styleReads.get(node) || 0) + 1);
    return nativeStyle(node);
  };
  let height = 120;
  Object.defineProperty(doc.body, "scrollHeight", { get: () => height });
  win.Element.prototype.getBoundingClientRect = function () {
    reads.set(this, (reads.get(this) || 0) + 1);
    const bottom =
      this === doc.body ? height : this.tagName === "DIV" ? 100 : 500;
    return { top: 0, bottom, width: 300, height: bottom };
  };
  win.eval(await heightReporter());
  const activate = (active, token = "height-performance") =>
    win.dispatchEvent(
      new win.MessageEvent("message", {
        source: parent,
        data: { type: "dsh-tavern-frame-measure-active", token, active },
      }),
    );
  const flush = async () => {
    await new Promise((r) => setImmediate(r));
    for (const callback of frames.splice(0)) callback();
    await new Promise((r) => setImmediate(r));
  };
  return {
    win,
    doc,
    reads,
    styleReads,
    posts,
    activate,
    flush,
    setHeight: (value) => (height = value),
    reset() {
      reads.clear();
      styleReads.clear();
    },
  };
}

test("高度与视口探测共用单次读取，下一次测量重新读取几何和样式", async (t) => {
  const h = await harness(t);
  await h.flush();
  assert.equal(h.posts.at(-1).height, 120);
  assert.ok([...h.reads.values()].every((count) => count === 1));
  assert.ok([...h.styleReads.values()].every((count) => count === 1));
  h.reset();
  h.setHeight(360);
  h.activate(true);
  await h.flush();
  assert.equal(h.posts.at(-1).height, 360);
  assert.ok([...h.reads.values()].every((count) => count === 1));
  assert.ok([...h.styleReads.values()].every((count) => count === 1));
});

test("暂停取消排队测量，恢复只执行当前generation且拒绝错误token", async (t) => {
  const h = await harness(t);
  h.activate(false);
  h.activate(true);
  await h.flush();
  assert.equal(h.reads.get(h.doc.body), 1);
  h.reset();
  h.activate(false);
  h.setHeight(480);
  h.activate(true, "old-document");
  await h.flush();
  assert.equal(h.reads.size, 0);
  assert.equal(h.posts.at(-1).height, 120);
  h.activate(true);
  await h.flush();
  assert.equal(h.posts.at(-1).height, 480);
});

test("纯绘制与重复属性写入不测量，实际布局属性继续测量", async (t) => {
  const h = await harness(t);
  await h.flush();
  h.reset();
  const node = h.doc.querySelector("div");
  node.setAttribute("class", "");
  await h.flush();
  h.reset();
  node.setAttribute("class", "");
  node.style.color = "red";
  node.style.opacity = ".7";
  await h.flush();
  assert.equal(h.reads.size, 0);
  node.className = "actual-layout-class";
  await h.flush();
  assert.ok(h.reads.size > 0);
  h.reset();
  node.style.height = "150px";
  await h.flush();
  assert.ok(h.reads.size > 0);
});

test("显式content布局关闭视口下限，fixed/viewport继续使用已有sizing模块", async () => {
  const content = await heightReporter({
    content: '<meta name="dsh-tavern-frame" content="content"><p>正文</p>',
  });
  assert.ok(content.endsWith(",false);"));
  for (const mode of ["fixed", "viewport"])
    assert.equal(
      await heightReporter({
        content: `<meta name="dsh-tavern-frame" content="${mode}" data-height="300"><p>正文</p>`,
      }),
      undefined,
    );
});

test("缺少rAF时用定时器合并且取消旧generation", async (t) => {
  const h = await harness(t, { raf: false });
  h.activate(false);
  h.activate(true);
  h.activate(true);
  await h.flush();
  assert.equal(h.reads.get(h.doc.body), 1);
  assert.equal(h.posts.at(-1).height, 120);
});
