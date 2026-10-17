import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const sourceRoot = new URL("../tavern-plugin/src/client/", import.meta.url);
const mobile = await readFile(
  new URL("modules/mobile-layout.js", sourceRoot),
  "utf8",
);
const helpers = (
  await readFile(new URL("ui/message-frame.js", sourceRoot), "utf8")
).split("// @include modules/mobile-layout.js")[0];
const markup =
  '<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}header{height:40px}[data-composer-seat]{height:80px}</style><div data-phase="active"><header>标题</header><div data-composer-seat><div data-composer-card>输入框</div></div></div>';

test("视口固定状态只在首次进入和离开时写入，真实尺寸变化继续同步", async () => {
  const dom = new JSDOM(markup, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const view = dom.window;
  try {
    const media = new Map();
    view.matchMedia = (query) => {
      if (!media.has(query))
        media.set(
          query,
          Object.assign(new view.EventTarget(), { matches: true }),
        );
      return media.get(query);
    };
    const vv = Object.assign(new view.EventTarget(), {
      height: 844,
      offsetTop: 0,
      scale: 1,
    });
    Object.defineProperty(view, "visualViewport", { value: vv });
    view.eval(
      `${helpers}\n${mobile}\nwindow.releasePin=installVisualViewportPin(document);`,
    );
    const html = view.document.documentElement;
    let classWrites = 0;
    const observer = new view.MutationObserver((records) => {
      classWrites += records.length;
    });
    observer.observe(html, { attributes: true, attributeFilter: ["class"] });
    const settle = () =>
      new Promise((resolve) =>
        view.requestAnimationFrame(() => view.requestAnimationFrame(resolve)),
      );
    for (const event of ["resize", "orientationchange", "pageshow"]) {
      view.dispatchEvent(new view.Event(event));
      await settle();
      assert.equal(classWrites, 0, `${event} 不重复写入 class`);
    }
    vv.height = 200;
    vv.dispatchEvent(new view.Event("resize"));
    await settle();
    assert.equal(html.style.getPropertyValue("--dsh-vv-height"), "200px");
    assert.ok(html.classList.contains("dsh-tavern-short-viewport"));
    assert.ok(classWrites > 0, "实际状态变化产生 class 通知");
    vv.scale = 2;
    vv.height = 100;
    vv.dispatchEvent(new view.Event("resize"));
    await settle();
    assert.equal(
      html.style.getPropertyValue("--dsh-vv-height"),
      "200px",
      "缩放时保留布局",
    );
    for (const entry of media.values()) entry.matches = false;
    view.dispatchEvent(new view.Event("resize"));
    await settle();
    assert.equal(html.classList.contains("dsh-tavern-viewport-pinned"), false);
    assert.equal(html.style.getPropertyValue("--dsh-vv-height"), "");
    vv.scale = 1;
    vv.height = 844;
    media.get("(max-width: 1023px)").matches = true;
    view.dispatchEvent(new view.Event("resize"));
    await settle();
    assert.ok(
      html.classList.contains("dsh-tavern-viewport-pinned"),
      "重新进入移动布局",
    );
    view.releasePin();
    assert.equal(html.classList.contains("dsh-tavern-viewport-pinned"), false);
    assert.equal(html.style.getPropertyValue("--dsh-vv-height"), "");
    vv.height = 300;
    vv.dispatchEvent(new view.Event("resize"));
    await settle();
    assert.equal(
      html.style.getPropertyValue("--dsh-vv-height"),
      "",
      "释放后不再同步",
    );
    observer.disconnect();
  } finally {
    view.close();
  }
});

test(
  "真实浏览器：重复视口事件不再触发消息全文配色，主题变化仍刷新",
  { skip: !process.env.TAVERN_BROWSER_TESTS },
  async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch(
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
        : {},
    );
    try {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      await page.route("**/*", (route) => route.abort());
      await page.setContent(
        markup +
          `<main>${Array.from({ length: 12 }, () => `<article>${"<p>普通文字<span>“合成对白”</span><em>强调文字</em></p>".repeat(20)}</article>`).join("")}</main>`,
      );
      // 只记录真实配色函数入口次数，不替换其 DOM 遍历和高亮逻辑。
      const colors = (
        await readFile(new URL("text-colors.js", sourceRoot), "utf8")
      ).replace(
        "function refresh() {",
        "function refresh() { window.refreshCount++;",
      );
      await page.addScriptTag({
        content: `window.refreshCount=0;${colors}\n${helpers}\n${mobile}\nwindow.colorHandles=Array.from(document.querySelectorAll('article'),root=>installTavernTextColors(root,{},findTavernQuoteRanges));window.releasePin=installVisualViewportPin(document);`,
      });
      await page.waitForTimeout(150);
      const count = await page.evaluate(async () => {
        window.refreshCount = 0;
        for (let i = 0; i < 10; i++) {
          window.dispatchEvent(new Event("resize"));
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        return window.refreshCount;
      });
      assert.equal(count, 0, "12条消息、10次不变视口不应重扫全文");
      await page.evaluate(() =>
        document.documentElement.classList.add("theme-test"),
      );
      await page.waitForTimeout(100);
      assert.equal(
        await page.evaluate(() => window.refreshCount),
        12,
        "真实根状态变化仍刷新每条消息",
      );
      await page.evaluate(() => {
        window.releasePin();
        window.colorHandles.forEach((handle) => handle.dispose());
      });
    } finally {
      await browser.close();
    }
  },
);
