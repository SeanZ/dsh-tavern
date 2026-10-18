import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { heightClient } from "./fixtures/frame-height-performance.mjs";

const tools = await import(
  process.env.TAVERN_PLAYWRIGHT_MODULE || "playwright"
);
const client = await heightClient();
const options = { skip: !process.env.TAVERN_BROWSER_TESTS, timeout: 45000 };
async function setup(t, content) {
  const browser = await tools[
    process.env.TAVERN_BROWSER_ENGINE || "chromium"
  ].launch(
    process.env.TAVERN_BROWSER_EXECUTABLE
      ? { executablePath: process.env.TAVERN_BROWSER_EXECUTABLE }
      : {},
  );
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(8000);
  await page.route("**/*", (route) => route.abort());
  await page.setContent(
    '<iframe style="display:block;width:100%;height:48px;border:0"></iframe>',
  );
  await page.evaluate(
    (html) => {
      window.reports = [];
      addEventListener("message", (event) => {
        if (
          event.source !== document.querySelector("iframe").contentWindow ||
          event.data?.type !== "dsh-tavern-frame-height"
        )
          return;
        reports.push(event.data.height);
        document.querySelector("iframe").style.height =
          event.data.height + "px";
      });
      document.querySelector("iframe").srcdoc = html;
    },
    client.buildTavernFrameDocument({
      content,
      token: "height-browser",
      runtimeReporting: false,
    }),
  );
  const frame = page.frames()[1];
  await frame.waitForSelector("body", { state: "attached" });
  const waitHeight = (height) =>
    page.waitForFunction(
      (height) => document.querySelector("iframe").clientHeight === height,
      height,
    );
  return { page, frame, waitHeight };
}

test(
  "真实iframe：absolute、裁剪、闭合details和小fixed按钮保持高度与点击区域",
  options,
  async (t) => {
    const { page, frame, waitHeight } = await setup(
      t,
      '<style>body{margin:0}#flow{height:80px}.clip{height:60px;overflow:auto}.inside{height:400px}summary{height:32px}#absolute{position:absolute;top:160px;height:140px;width:95%}button{height:24px}#floating{position:fixed;right:0;top:0;width:24px;height:24px}#absolute button{position:absolute;bottom:0}input{width:120px}</style><div id="flow">正文</div><div class="clip"><div class="inside">嵌套滚动</div></div><details><summary>折叠</summary><div style="height:100vh">隐藏面板</div></details><div id="absolute"><input aria-label="卡片输入"><button onclick="window.clicks=(window.clicks||0)+1">底部按钮</button></div><button id="floating">+</button>',
    );
    await waitHeight(300);
    await frame.getByRole("button", { name: "底部按钮", exact: true }).click();
    assert.equal(await frame.evaluate(() => window.clicks), 1);
    await frame.getByRole("textbox", { name: "卡片输入" }).fill("输入保留");
    assert.equal(await frame.getByRole("textbox").inputValue(), "输入保留");
    await frame.locator(".clip").hover();
    await page.mouse.wheel(0, 120);
    await frame.waitForFunction(
      () => document.querySelector(".clip").scrollTop > 0,
    );
    assert.equal(
      await page.locator("iframe").evaluate((node) => node.clientHeight),
      300,
    );
    const before = await page.evaluate(() => reports.length);
    await page.waitForTimeout(200);
    assert.equal(
      await page.evaluate(() => reports.length),
      before,
      "静态后高度报告收敛",
    );
  },
);

test(
  "真实iframe：class、样式表、CSSOM下一次测量和details变化不保留旧布局缓存",
  options,
  async (t) => {
    const { page, frame, waitHeight } = await setup(
      t,
      '<style>body{margin:0}#flow{height:40px}#target{position:absolute;top:100px;height:100px;width:90%}.tall #target{top:220px;height:140px}summary{height:32px}.inside{height:500px}</style><div id="flow">正文</div><div id="target">动态区域</div><details><summary>展开</summary><div class="inside">更多内容</div></details>',
    );
    await waitHeight(200);
    await frame.evaluate(() => (document.body.className += " tall"));
    await waitHeight(360);
    await frame.evaluate(() => {
      const style = document.createElement("style");
      style.id = "dynamic-style";
      style.textContent = "#target{top:400px!important;height:60px!important}";
      document.head.append(style);
    });
    await waitHeight(460);
    await frame.evaluate(() =>
      document
        .querySelector("#dynamic-style")
        .sheet.insertRule(
          "#target{top:600px!important;height:80px!important}",
          1,
        ),
    );
    // CSSOM没有统一DOM通知；下一次既有激活测量必须读取新规则，不使用跨次分类缓存。
    await page.evaluate(() =>
      document.querySelector("iframe").contentWindow.postMessage(
        {
          type: "dsh-tavern-frame-measure-active",
          token: "height-browser",
          active: true,
        },
        "*",
      ),
    );
    await waitHeight(680);
    await frame.evaluate(() => document.querySelector("#target").remove());
    await waitHeight(72);
    await frame.locator("summary").click();
    await waitHeight(572);
    await frame.locator("summary").click();
    await waitHeight(72);
    await frame.evaluate(
      () => (document.querySelector(".inside").style.height = "100vh"),
    );
    await page.waitForTimeout(100);
    assert.equal(
      await page.locator("iframe").evaluate((node) => node.clientHeight),
      72,
    );
  },
);

for (const kind of ["fixed", "viewport", "header"])
  test(
    `真实iframe：${kind}视口布局收敛且内部底部按钮可操作`,
    options,
    async (t) => {
      const css =
        kind === "fixed"
          ? "position:fixed;inset:0;overflow:auto"
          : "height:100vh;overflow:auto";
      const { page, frame } = await setup(
        t,
        `<style>body{margin:0}header{height:40px}#panel{${css}}#inside{height:2000px;position:relative}button{position:absolute;bottom:0;height:32px}</style>${kind === "header" ? "<header>标题</header>" : ""}<div id="panel"><div id="inside"><button onclick="window.clicks=(window.clicks||0)+1">滚动到底</button></div></div>`,
      );
      await page.waitForFunction(() => {
        const height = document.querySelector("iframe").clientHeight;
        return height >= 844 && height <= 924;
      });
      await page.waitForTimeout(150);
      assert.ok(await page.evaluate(() => reports.length < 10));
      await frame
        .getByRole("button", { name: "滚动到底", exact: true })
        .click();
      assert.equal(await frame.evaluate(() => window.clicks), 1);
      assert.ok(
        await frame.locator("#panel").evaluate((node) => node.scrollTop > 0),
      );
      const beforeRotate = await page
        .locator("iframe")
        .evaluate((node) => node.clientHeight);
      await page.setViewportSize({ width: 844, height: 390 });
      await page.waitForTimeout(200);
      const height = await page
        .locator("iframe")
        .evaluate((node) => node.clientHeight);
      // 旧的未知卡片视口下限只负责撑开，不承诺随父视口缩小；保留基线几何与反馈锁。
      assert.equal(height, beforeRotate);
      const count = await page.evaluate(() => reports.length);
      await page.waitForTimeout(150);
      assert.equal(
        await page.evaluate(() => reports.length),
        count,
        "旋转后测量结果收敛",
      );
      // 旧legacy面板保持较高iframe，用户需滚动父页露出底部；使用实际指针验证点击。
      await page.evaluate(() =>
        window.scrollTo(0, document.documentElement.scrollHeight),
      );
      const box = await frame
        .getByRole("button", { name: "滚动到底", exact: true })
        .boundingBox();
      assert.ok(
        box && box.y >= 0 && box.y + box.height <= 390,
        JSON.stringify(box),
      );
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      assert.equal(await frame.evaluate(() => window.clicks), 2);
    },
  );

test("真实iframe：字体实际加载改变换行后重新测量高度", options, async (t) => {
  const font = await readFile(
    new URL(
      "../tavern-plugin/lib/vendor/runtime-assets/fontawesome/webfonts/fa-solid-900.woff2",
      import.meta.url,
    ),
  );
  const { page, frame } = await setup(
    t,
    `<style>body{margin:0}p{margin:0;width:180px;font:24px/30px monospace;overflow-wrap:anywhere}</style><p>${"\uf000".repeat(100)}</p>`,
  );
  await page.waitForTimeout(120);
  const before = await page
    .locator("iframe")
    .evaluate((node) => node.clientHeight);
  await frame.evaluate(async (base64) => {
    const face = new FontFace(
      "HeightTest",
      "url(data:font/woff2;base64," + base64 + ")",
      { weight: "900" },
    );
    document.fonts.add(face);
    document.querySelector("p").style.fontFamily = "HeightTest,monospace";
    document.querySelector("p").style.fontWeight = "900";
    await face.load();
    await document.fonts.ready;
    window.expectedFontHeight = Math.max(
      48,
      Math.ceil(document.body.getBoundingClientRect().bottom),
    );
  }, font.toString("base64"));
  const expected = await frame.evaluate(() => expectedFontHeight);
  await page.waitForFunction(
    (height) => document.querySelector("iframe").clientHeight === height,
    expected,
  );
  assert.notEqual(expected, before, "字体实际加载改变了行数");
});
