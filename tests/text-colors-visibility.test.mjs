import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const browserTools = await import(
  process.env.TAVERN_PLAYWRIGHT_MODULE || "playwright"
);
import { helperClient } from "./fixtures/helper-host-harness.mjs";

const source = await readFile(
  new URL("../tavern-plugin/src/client/text-colors.js", import.meta.url),
  "utf8",
);
const launch = () =>
  browserTools[process.env.TAVERN_BROWSER_ENGINE || "chromium"].launch(
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  );
const settle = (page) => page.waitForTimeout(90);
async function prepare(page) {
  await page.setContent(
    '<style>:root{color:#222}.dark{color:#ddd}</style><article><p>“你好，<b>朋友</b>。”<em>心声</em><span style="color:red">“作者色”</span></p></article>',
  );
  await page.addScriptTag({
    content:
      source +
      `
    window.scans=0;const walk=document.createTreeWalker.bind(document);
    document.createTreeWalker=(...args)=>{window.scans++;return walk(...args)};
    window.ranges=()=>[...CSS.highlights.values()].flatMap(h=>[...h].map(r=>r.toString()));
    window.original=document.querySelector('article').innerHTML;
    window.colors=installTavernTextColors(document.querySelector('article'),{},findTavernQuoteRanges);`,
  });
  await settle(page);
}

test(
  "真实浏览器：重复或无关根样式不重扫，实际主题和流式内容仍更新",
  { skip: !process.env.TAVERN_BROWSER_TESTS, timeout: 30000 },
  async () => {
    const browser = await launch();
    try {
      const page = await browser.newPage();
      await prepare(page);
      const initial = await page.evaluate(() => scans);
      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => {
          document.documentElement.setAttribute("class", "");
          document.documentElement.style.height = "100%";
        });
        await settle(page);
      }
      assert.equal(
        await page.evaluate(() => scans),
        initial,
        "无关重复根属性不重扫全文",
      );
      await page.evaluate(() => (document.documentElement.className = "dark"));
      await settle(page);
      assert.equal(await page.evaluate(() => scans), initial + 1);
      assert.ok(
        await page.evaluate(() =>
          [...CSS.highlights]
            .filter(([name]) => name.endsWith("-dark"))
            .some(([, h]) => h.size > 0),
        ),
      );
      await page.evaluate(
        () => (document.querySelector("b").firstChild.data = "新朋友"),
      );
      await settle(page);
      assert.ok(await page.evaluate(() => ranges().includes("新朋友")));
      assert.ok(await page.evaluate(() => !ranges().includes("“作者色”")));
    } finally {
      await browser.close();
    }
  },
);

test(
  "真实浏览器：离屏和页面隐藏取消扫描，恢复只刷新一次且销毁后无任务",
  { skip: !process.env.TAVERN_BROWSER_TESTS, timeout: 30000 },
  async () => {
    const browser = await launch();
    try {
      const page = await browser.newPage();
      await prepare(page);
      const result = await page.evaluate(async () => {
        const wait = () => new Promise((r) => setTimeout(r, 90));
        colors.setActive(false);
        const paused = scans;
        document.querySelector("b").firstChild.data = "暂停期间的新朋友";
        document.documentElement.className = "dark";
        colors.setEnabled(true);
        colors.setColors({ quote: "#123456" });
        await wait();
        const hiddenScans = scans;
        colors.setActive(true);
        colors.setActive(true);
        await wait();
        const resumed = scans;
        const correct = ranges().includes("暂停期间的新朋友");
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
        document.querySelector("b").textContent = "后台更改";
        await wait();
        const background = scans;
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
        await wait();
        const foreground = scans;
        document.querySelector("b").textContent = "销毁前更改";
        colors.dispose();
        await wait();
        return {
          paused,
          hiddenScans,
          resumed,
          correct,
          background,
          foreground,
          disposed: scans,
          highlights: CSS.highlights.size,
        };
      });
      assert.equal(result.hiddenScans, result.paused);
      assert.equal(result.resumed, result.paused + 1);
      assert.equal(result.correct, true);
      assert.equal(result.background, result.resumed);
      assert.equal(result.foreground, result.background + 1);
      assert.equal(result.disposed, result.foreground);
      assert.equal(result.highlights, 0);
    } finally {
      await browser.close();
    }
  },
);

test(
  "真实 iframe：复用测量可见性通道，持久面板保持不安装配色器",
  { skip: !process.env.TAVERN_BROWSER_TESTS, timeout: 30000 },
  async () => {
    const browser = await launch();
    try {
      const page = await browser.newPage();
      const html = helperClient.buildTavernFrameDocument({
        content: "<p>“iframe 对白”</p>",
        token: "colors-visible",
        runtimeReporting: false,
      });
      assert.ok(
        !helperClient
          .buildTavernFrameDocument({
            content: "<p>panel</p>",
            persistent: true,
            token: "panel",
          })
          .includes("<script data-dsh-tavern-text-colors>"),
      );
      const script = html.match(
        /<script data-dsh-tavern-text-colors>([\s\S]*?)<\/script>/,
      )[1];
      await page.setContent("<iframe></iframe>");
      await page.evaluate((script) => {
        const frame = document.querySelector("iframe");
        frame.srcdoc =
          "<p>“iframe 对白”</p><script>window.scans=0;const walk=document.createTreeWalker.bind(document);document.createTreeWalker=(...args)=>{scans++;return walk(...args)};</" +
          "script><script>" +
          script +
          "</" +
          "script>";
      }, script);
      await page.waitForFunction(
        () => document.querySelector("iframe").contentWindow.scans === 0,
      );
      const send = (active) =>
        page.evaluate((active) => {
          const frame = document.querySelector("iframe");
          frame.contentWindow.postMessage(
            {
              type: "dsh-tavern-frame-measure-active",
              token: "colors-visible",
              active,
            },
            "*",
          );
          frame.contentWindow.postMessage(
            {
              type: "dsh-tavern-text-colors",
              token: "colors-visible",
              enabled: true,
              textColorOverrides: { quote: "#112233" },
            },
            "*",
          );
        }, active);
      await send(false);
      await settle(page);
      assert.equal(
        await page.evaluate(
          () => document.querySelector("iframe").contentWindow.scans,
        ),
        0,
        "离屏 iframe 不扫描",
      );
      await send(true);
      await settle(page);
      assert.equal(
        await page.evaluate(
          () => document.querySelector("iframe").contentWindow.scans,
        ),
        1,
      );
      await send(true);
      await settle(page);
      assert.equal(
        await page.evaluate(
          () => document.querySelector("iframe").contentWindow.scans,
        ),
        1,
        "重复激活和相同配色不重扫",
      );
    } finally {
      await browser.close();
    }
  },
);

test(
  "真实 React 正文共享可见性观察器，离屏内容和暂停期间主题在恢复后收敛",
  { skip: !process.env.TAVERN_BROWSER_TESTS, timeout: 30000 },
  async () => {
    const { browserReactScript } = await import("./fixtures/browser-react.mjs");
    const theme = await readFile(
      new URL(
        "../tavern-plugin/src/client/modules/host-theme.js",
        import.meta.url,
      ),
      "utf8",
    );
    const browser = await launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      await page.setContent(
        "<style>body{margin:0;color:#222;--dsw-alias-brand-primary:#123456}article{height:300px}</style><main></main>",
      );
      await page.addScriptTag({ content: await browserReactScript() });
      await page.addScriptTag({
        content: `const React=modules.react;const DshUi={MarkdownText:props=>React.createElement('article',null,React.createElement('p',null,props.text),React.createElement('span',null,'“作者对白”'))};
      ${source}\n${theme}
      window.observers=0;const IO=window.IntersectionObserver;window.IntersectionObserver=class extends IO{constructor(...args){super(...args);observers++}};
      window.scanCounts=new Map();const walk=document.createTreeWalker.bind(document);document.createTreeWalker=(root,...args)=>{scanCounts.set(root,(scanCounts.get(root)||0)+1);return walk(root,...args)};
      window.reactRoot=modules['react-dom/client'].createRoot(document.querySelector('main'));
      window.renderMessages=text=>reactRoot.render(React.createElement(React.Fragment,null,...Array.from({length:32},(_,i)=>React.createElement(TavernColoredMarkdown,{key:i,text:text+i}))));
      renderMessages('“合成对白”');`,
      });
      await page.waitForFunction(
        () => document.querySelectorAll("article").length === 32,
      );
      await settle(page);
      await settle(page);
      const initial = await page.evaluate(() => ({
        observers,
        active: scanCounts.size,
        scans: [...scanCounts.values()].reduce((a, b) => a + b, 0),
      }));
      assert.equal(initial.observers, 1);
      await settle(page);
      await settle(page);
      assert.equal(
        await page.evaluate(() =>
          [...scanCounts.values()].reduce((a, b) => a + b, 0),
        ),
        initial.scans,
        "批量挂载后静止不反复扫描",
      );

      assert.ok(
        initial.active > 0 && initial.active <= 5,
        JSON.stringify(initial),
      );
      await page.addStyleTag({
        content:
          "html.author-color span{color:red}body.author-color span{color:red}",
      });
      await page.evaluate(
        () => (document.documentElement.className = "author-color"),
      );
      await settle(page);
      assert.equal(
        await page.evaluate(() =>
          [...CSS.highlights.values()].some((h) =>
            [...h].some((r) => r.toString().includes("作者对白")),
          ),
        ),
        false,
        "未知html作者class变化后不能覆盖作者颜色",
      );
      await page.evaluate(() => (document.documentElement.className = ""));
      await settle(page);
      assert.ok(
        await page.evaluate(() =>
          [...CSS.highlights.values()].some((h) =>
            [...h].some((r) => r.toString().includes("作者对白")),
          ),
        ),
      );
      await page.evaluate(() => (document.body.className = "author-color"));
      await settle(page);
      assert.equal(
        await page.evaluate(() =>
          [...CSS.highlights.values()].some((h) =>
            [...h].some((r) => r.toString().includes("作者对白")),
          ),
        ),
        false,
        "body作者class也共享失效",
      );
      await page.evaluate(() => (document.body.className = ""));
      await settle(page);
      const authorStyle = await page.addStyleTag({
        content: "span{color:red}",
      });
      await settle(page);
      assert.equal(
        await page.evaluate(() =>
          [...CSS.highlights.values()].some((h) =>
            [...h].some((r) => r.toString().includes("作者对白")),
          ),
        ),
        false,
        "作者样式表变化也不能留下覆盖颜色的旧Range",
      );
      await authorStyle.evaluate((node) => node.remove());
      await settle(page);

      await page.evaluate(() => {
        window.before = new Map(scanCounts);
        renderMessages("“流式新对白”");
        document.documentElement.style.height = "100%";
      });
      await settle(page);
      await settle(page);
      assert.ok(
        await page.evaluate(() =>
          [...scanCounts].every(
            ([root, count]) => count === (before.get(root) || 0) + 1,
          ),
        ),
        "每个临近视区消息流式更新只合并一次",
      );
      const last = page.locator("article").last();
      await page.evaluate(() =>
        document.body.style.setProperty("--dsw-alias-brand-primary", "#654321"),
      );
      await settle(page);
      await last.scrollIntoViewIfNeeded();
      await settle(page);
      await settle(page);
      assert.ok(
        await page.evaluate(() =>
          [...CSS.highlights.values()].some((h) =>
            [...h].some((r) => r.toString().includes("流式新对白")),
          ),
        ),
      );
      const lastColor = await page
        .locator(".dsh-tavern-colored-markdown")
        .last()
        .evaluate((root) => {
          const range = [...CSS.highlights].find(([, h]) =>
            [...h].some((r) => root.contains(r.startContainer)),
          );
          return getComputedStyle(root, "::highlight(" + range[0] + ")").color;
        });
      assert.equal(lastColor, "rgb(101, 67, 33)");
      await page.evaluate(() => {
        reactRoot.unmount();
        window.afterUnmount = [...scanCounts.values()].reduce(
          (a, b) => a + b,
          0,
        );
        document.documentElement.className = "after-dispose";
      });
      await settle(page);
      assert.equal(
        await page.evaluate(() =>
          [...scanCounts.values()].reduce((a, b) => a + b, 0),
        ),
        await page.evaluate(() => afterUnmount),
      );
      assert.equal(await page.evaluate(() => CSS.highlights.size), 0);
      console.log("32 条 React 正文：" + JSON.stringify(initial));
    } finally {
      await browser.close();
    }
  },
);

test(
  "真实浏览器：缺少 CSS Highlight 时保留正文和全部生命周期空操作",
  { skip: !process.env.TAVERN_BROWSER_TESTS, timeout: 30000 },
  async () => {
    const browser = await launch();
    try {
      const page = await browser.newPage();
      await page.setContent("<article>“普通正文”<em>心声</em></article>");
      await page.evaluate(() =>
        Object.defineProperty(window, "Highlight", {
          configurable: true,
          value: undefined,
        }),
      );
      await page.addScriptTag({ content: source });
      const result = await page.evaluate(() => {
        const root = document.querySelector("article"),
          original = root.innerHTML;
        const control = installTavernTextColors(
          root,
          {},
          findTavernQuoteRanges,
        );
        control.setActive(false);
        control.setEnabled(true);
        control.setColors({ quote: "red" });
        control.refreshTheme();
        control.dispose();
        return {
          unchanged: root.innerHTML === original,
          styles: document.querySelectorAll(
            "style[data-dsh-tavern-text-colors]",
          ).length,
        };
      });
      assert.deepEqual(result, { unchanged: true, styles: 0 });
    } finally {
      await browser.close();
    }
  },
);
