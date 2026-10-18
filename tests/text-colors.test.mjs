import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const source = await readFile(
  new URL("../tavern-plugin/src/client/text-colors.js", import.meta.url),
  "utf8",
);
function fixture(supports = true) {
  const dom = new JSDOM(
    "<style>body{color:rgb(20,20,20)}</style><main><p>“你好，<span>朋友</span>。”<em>心声</em></p></main>",
    { runScripts: "outside-only", pretendToBeVisual: true },
  );
  const win = dom.window;
  if (supports) {
    win.CSS = { supports: () => true, highlights: new Map() };
    win.Highlight = class extends Set {};
  }
  win.eval(
    source +
      ';window.colors=installTavernTextColors(document.querySelector("main"),{},findTavernQuoteRanges);',
  );
  return { dom, win, colors: win.colors };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
test("未支持 CSS Highlight 时所有配色控制保持空操作", () => {
  const { dom, colors } = fixture(false);
  try {
    colors.setActive(false);
    colors.refreshTheme();
    colors.setColors({ quote: "red" });
    colors.setEnabled(true);
    colors.dispose();
    assert.equal(
      dom.window.document.querySelectorAll("style[data-dsh-tavern-text-colors]")
        .length,
      0,
    );
  } finally {
    dom.window.close();
  }
});
test("暂停取消既有任务并断开内容观察，恢复合并刷新且保持 React 所有的原 DOM", async () => {
  const { dom, win, colors } = fixture();
  try {
    let scans = 0;
    const walk = win.document.createTreeWalker.bind(win.document);
    win.document.createTreeWalker = (...args) => {
      scans++;
      return walk(...args);
    };
    const root = win.document.querySelector("main"),
      original = root.innerHTML;
    colors.setActive(false);
    await settle();
    assert.equal(
      [...win.CSS.highlights.values()].reduce((n, h) => n + h.size, 0),
      0,
    );
    colors.setActive(true);
    colors.setActive(true);
    await settle();
    const ranges = () =>
      [...win.CSS.highlights.values()].flatMap((h) =>
        [...h].map((r) => r.toString()),
      );
    assert.ok(ranges().includes("朋友"));
    assert.equal(scans, 1, "重复恢复只安排一次扫描");
    colors.setEnabled(true);
    await settle();
    assert.equal(scans, 1);
    assert.equal(root.innerHTML, original);
    colors.setActive(false);
    root.querySelector("span").firstChild.data = "新朋友";
    await settle();
    colors.setActive(true);
    await settle();
    assert.ok(ranges().includes("新朋友"));
    assert.equal(scans, 2);
    root.querySelector("span").textContent = "取消的刷新";
    colors.dispose();
    await settle();
    assert.equal(win.CSS.highlights.size, 0);
    assert.equal(
      win.document.querySelector("style[data-dsh-tavern-text-colors]"),
      null,
    );
  } finally {
    dom.window.close();
  }
});

test("没有 IntersectionObserver 时普通正文保持激活并能释放订阅", () => {
  const { dom, win } = fixture();
  try {
    let active;
    const stop = win.subscribeTavernTextColorVisibility(
      win.document.querySelector("main"),
      (value) => (active = value),
    );
    assert.equal(active, true);
    stop();
  } finally {
    win.colors.dispose();
    dom.window.close();
  }
});

test("共享主题最后退订后，旧窗口待执行rAF不能污染新订阅", async () => {
  const theme = await readFile(
    new URL(
      "../tavern-plugin/src/client/modules/host-theme.js",
      import.meta.url,
    ),
    "utf8",
  );
  const client = vm.runInNewContext(
    source +
      "\n" +
      theme +
      ";({subscribeTavernHostTheme,currentTavernHostTheme})",
  );
  const oldDom = new JSDOM(
    '<body style="--dsh-content-font-size:18px;color:black"></body>',
    { pretendToBeVisual: true },
  );
  const newDom = new JSDOM(
    '<body style="--dsh-content-font-size:24px;color:black"></body>',
    { pretendToBeVisual: true },
  );
  const queue = [];
  oldDom.window.requestAnimationFrame = (work) => queue.push(work);
  let stopOld, stopNew;
  try {
    stopOld = client.subscribeTavernHostTheme(oldDom.window, () => {});
    oldDom.window.document.documentElement.className = "old-theme";
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(queue.length, 1);
    stopOld();
    stopOld = null;
    stopNew = client.subscribeTavernHostTheme(newDom.window, () => {});
    queue[0]();
    assert.equal(client.currentTavernHostTheme(newDom.window).fontSize, 24);
  } finally {
    stopOld?.();
    stopNew?.();
    oldDom.window.close();
    newDom.window.close();
  }
});
