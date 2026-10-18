// 真实浏览器 iframe：生成文档 + 既有 frame 通道 + 公开入口 tavernUi.captureFrameSnapshot。
// 普通 resize/console 压力下 DOM 克隆/整体序列化为 0；显式快照的预算边界可辨识；30 轮浏览器内重建/请求/停止。
// 引擎与可执行文件由环境指定：TAVERN_TEST_BROWSER=chromium|webkit，PLAYWRIGHT_EXECUTABLE_PATH（或 PLAYWRIGHT_CHROMIUM_EXECUTABLE）。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as playwright from "playwright";

const clientSource = await readFile(
  new URL("../tavern-plugin/lib/client.js", import.meta.url),
  "utf8",
);
const engineName =
  process.env.TAVERN_TEST_BROWSER === "webkit" ? "webkit" : "chromium";
const executablePath =
  process.env.PLAYWRIGHT_EXECUTABLE_PATH ||
  (engineName === "chromium"
    ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    : process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE);

// 探针脚本带与内部上报器相同的标记：采集结果里不应出现它。
const INSTRUMENT = `<script data-dsh-tavern-frame data-test-instrument>(function(){var c={cloneNode:0,innerHTML:0,outerHTML:0};window.__dshCounts=c;
var clone=Node.prototype.cloneNode;Node.prototype.cloneNode=function(){c.cloneNode+=1;return clone.apply(this,arguments);};
["innerHTML","outerHTML"].forEach(function(name){var d=Object.getOwnPropertyDescriptor(Element.prototype,name);
Object.defineProperty(Element.prototype,name,{configurable:true,enumerable:d.enumerable,get:function(){c[name]+=1;return d.get.call(this);},set:function(v){return d.set.call(this,v);}});});})();</script>`;

// 合成场景：600 个兄弟 li（默认 maxChildren 200 截断）、2 万字符段落（默认 maxTextChars 2000 截断）、
// 100 层嵌套（默认 maxDepth 64 截断，放宽到 128 可达叶子）、一段卡片自己的 script（必须保留）。
function syntheticContent(rows = 600, depth = 100) {
  const list = Array.from(
    { length: rows },
    (_, i) =>
      '<li class="row" data-index="' +
      i +
      '">第 ' +
      i +
      " 行 · 生命 " +
      (i % 100) +
      "</li>",
  ).join("");
  let deep = '<b id="leaf">deep leaf</b>';
  for (let i = 0; i < depth; i++)
    deep = '<div class="d' + i + '">' + deep + "</div>";
  return (
    INSTRUMENT +
    '<div id="status"><ul>' +
    list +
    '</ul><p id="long">' +
    "x".repeat(20000) +
    "</p>" +
    deep +
    "</div><script data-card-probe>window.__cardScript=1</script>"
  );
}

async function openPage(t) {
  const engine = playwright[engineName];
  const browser = await engine.launch(
    Object.assign(
      { headless: true, timeout: 30000 },
      executablePath ? { executablePath } : {},
    ),
  );
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(20000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // 只提供合成宿主页；依赖脚本/样式为空，其余请求拒绝，避免联网及 HTML 冒充 JS 的伪错误。
  await page.route("**/*", (route) => {
    const request = route.request();
    if (request.url() === "http://tavern.test/")
      return route.fulfill({
        contentType: "text/html",
        body: '<main id="root"></main>',
      });
    if (request.resourceType() === "script")
      return route.fulfill({ contentType: "application/javascript", body: "" });
    if (request.resourceType() === "stylesheet")
      return route.fulfill({ contentType: "text/css", body: "" });
    return route.abort();
  });
  await page.goto("http://tavern.test/");
  await page.addScriptTag({
    content: `window.__ModuleLoader__={load(d){window.client=d.factory(()=>({}));}};`,
  });
  await page.addScriptTag({ content: clientSource });
  await page.evaluate(() => {
    window.__captures = [];
    window.__metrics = [];
    window.__reports = [];
    window.addEventListener("message", (event) => {
      const data = event.data;
      if (data && data.type === "dsh-tavern-frame-runtime")
        window.__reports.push({
          token: data.token,
          requestId: data.requestId || null,
          status: data.runtime.domSnapshot.status,
          domLength: data.runtime.dom.length,
        });
    });
    // 用生成文档真正挂一个 iframe：通过 lifecycle 的 ref 接入既有通道。
    window.__mount = function (props) {
      const life = window.client.createTavernMessageFrameLifecycle(props, {
        window,
        rpc(method, args) {
          window.__captures.push({
            method,
            args: JSON.parse(JSON.stringify(args)),
          });
          return Promise.resolve({ captured: true });
        },
        invalidate() {},
        diagnostics: {
          noteFrameRuntime(metrics) {
            window.__metrics.push(metrics);
          },
        },
      });
      const stop = life.start(() => {});
      const doc = life.snapshot().visibleDocument;
      const frame = document.createElement("iframe");
      frame.className = "live";
      frame.style.cssText = "width:390px;height:600px";
      frame.srcdoc = doc.html;
      document.querySelector("#root").appendChild(frame);
      doc.ref(frame);
      return {
        life,
        stop,
        frame,
        token: doc.token,
        unmount() {
          doc.ref(null);
          frame.remove();
        },
      };
    };
  });
  return { page, errors };
}

test(
  "普通 resize/console 压力下默认上报不克隆、不序列化 body；公开入口显式快照按预算截断且可辨识",
  { timeout: 120000 },
  async (t) => {
    const { page, errors } = await openPage(t);
    await page.evaluate((content) => {
      window.__main = window.__mount({
        sessionId: "s",
        turn: 1,
        partIndex: 0,
        content,
        eager: true,
        trustedCardMode: true,
        panelId: "status",
        placement: "message",
      });
    }, syntheticContent());
    await page.waitForFunction(
      () =>
        window.__reports.length >= 1 &&
        window.__main.frame.contentWindow.__dshCounts &&
        window.__main.frame.contentWindow.__cardScript === 1,
      null,
      { timeout: 30000 },
    );
    const frameNodes = await page.evaluate(
      () =>
        window.__main.frame.contentDocument.querySelectorAll("#status *")
          .length,
    );
    assert.ok(frameNodes > 700, "合成 DOM 已加载: " + frameNodes);

    const before = await page.evaluate(() => ({
      counts: { ...window.__main.frame.contentWindow.__dshCounts },
      reports: window.__reports.length,
    }));
    for (let round = 0; round < 10; round++) {
      await page.evaluate((round) => {
        const win = window.__main.frame.contentWindow;
        for (let i = 0; i < 20; i++)
          win.console.log("round", round, "entry", i, { hp: i });
        for (let i = 0; i < 5; i++) win.dispatchEvent(new win.Event("resize"));
        win.console.error("synthetic failure", new win.Error("boom " + round));
      }, round);
      await page.waitForTimeout(400);
    }
    await page.waitForFunction(
      (count) => window.__reports.length >= count + 5,
      before.reports,
      { timeout: 15000 },
    );
    const after = await page.evaluate(() => ({
      counts: { ...window.__main.frame.contentWindow.__dshCounts },
      reports: window.__reports.slice(),
    }));
    const pressureReports = after.reports.slice(before.reports);
    assert.ok(
      pressureReports.length >= 5,
      "压力期间应产生多次默认上报: " + pressureReports.length,
    );
    assert.ok(
      pressureReports.every(
        (item) =>
          item.requestId === null &&
          item.status === "not_collected" &&
          item.domLength === 0,
      ),
      JSON.stringify(pressureReports.slice(0, 3)),
    );
    assert.deepEqual(
      [
        after.counts.cloneNode - before.counts.cloneNode,
        after.counts.innerHTML - before.counts.innerHTML,
        after.counts.outerHTML - before.counts.outerHTML,
      ],
      [0, 0, 0],
      "压力期间 cloneNode/innerHTML/outerHTML 次数",
    );

    // 公开入口：未指定轮次命中当前挂着的 frame；小预算 partial(nodes)；默认预算 children/text/depth 全部截断；放宽后只剩 text。
    const small = await page.evaluate(() =>
      window.client.tavernUiService.captureFrameSnapshot({
        gameId: "s",
        budget: { maxNodes: 100, maxChars: 4000 },
      }),
    );
    assert.deepEqual(
      {
        gameId: small.gameId,
        turn: small.turn,
        partIndex: small.partIndex,
        panelId: small.panelId,
        status: small.status,
      },
      {
        gameId: "s",
        turn: 1,
        partIndex: 0,
        panelId: "status",
        status: "partial",
      },
    );
    assert.ok(
      small.domSnapshot.reasons.includes("nodes") ||
        small.domSnapshot.reasons.includes("chars"),
      small.domSnapshot.reasons.join(","),
    );
    assert.ok(
      small.domSnapshot.visited.nodes <= 100,
      String(small.domSnapshot.visited.nodes),
    );
    assert.ok(small.dom.length <= 4000, String(small.dom.length));
    assert.match(small.dom, /<li class="row" data-index="0">第 0 行/);
    assert.doesNotMatch(
      small.dom,
      /data-test-instrument|__dshCounts|data-dsh-tavern-frame/,
    );
    const defaults = await page.evaluate(() =>
      window.client.tavernUiService.captureFrameSnapshot({ gameId: "s" }),
    );
    assert.equal(defaults.status, "partial");
    assert.deepEqual(defaults.domSnapshot.reasons.slice().sort(), [
      "children",
      "depth",
      "text",
    ]);
    assert.equal(defaults.domSnapshot.skipped.children, 400);
    assert.equal(defaults.domSnapshot.visited.maxDepth, 64);
    assert.doesNotMatch(defaults.dom, /deep leaf/);
    assert.match(
      defaults.dom,
      /<script data-card-probe="">window\.__cardScript=1<\/script>/,
      "卡片自己的 script 保留",
    );
    assert.ok(defaults.domSnapshot.visited.nodes <= 2000);
    const wide = await page.evaluate(() =>
      window.client.tavernUiService.captureFrameSnapshot({
        gameId: "s",
        budget: {
          maxNodes: 5000,
          maxChars: 100000,
          maxChildren: 1000,
          maxDepth: 128,
        },
      }),
    );
    assert.equal(wide.status, "partial");
    assert.deepEqual(
      wide.domSnapshot.reasons,
      ["text"],
      "2 万字符段落超过单文本上限，其余完整",
    );
    assert.match(wide.dom, /<b id="leaf">deep leaf<\/b>/);
    assert.ok(wide.domSnapshot.visited.nodes > 1300);
    assert.equal(typeof wide.domSnapshot.capturedAt, "number");
    assert.equal(
      wide.domSnapshot.documentToken,
      await page.evaluate(() => window.__main.token),
    );
    const counts = await page.evaluate(() => ({
      ...window.__main.frame.contentWindow.__dshCounts,
    }));
    assert.deepEqual(
      [
        counts.cloneNode - after.counts.cloneNode,
        counts.innerHTML - after.counts.innerHTML,
      ],
      [0, 0],
      "显式采集也不克隆、不整体序列化",
    );

    // parent/token 校验：页面冒充父窗口向 iframe 发请求（source 是 parent 但 token 错误）不触发采集。
    const forged = await page.evaluate(async () => {
      const before = window.__reports.length;
      window.__main.frame.contentWindow.postMessage(
        {
          type: "dsh-tavern-frame-snapshot-request",
          token: "forged",
          requestId: "forged:1",
        },
        "*",
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      return window.__reports
        .slice(before)
        .filter((item) => item.requestId === "forged:1").length;
    });
    assert.equal(forged, 0);

    // 快照经 1 秒合并进入 captureDisplayRuntime，同文档轻量包没有覆盖它；诊断指标只有数值。
    await page.waitForFunction(
      () =>
        window.__captures.some(
          (call) =>
            call.args.runtime.domSnapshot &&
            call.args.runtime.domSnapshot.status !== "not_collected",
        ),
      null,
      { timeout: 5000 },
    );
    const captures = await page.evaluate(() =>
      window.__captures.map((call) => ({
        turn: call.args.turn,
        status: call.args.runtime.domSnapshot.status,
        domLength: call.args.runtime.dom.length,
        panelId: call.args.runtime.panelId,
      })),
    );
    assert.ok(
      captures.every((item) => item.turn === 1 && item.panelId === "status"),
    );
    assert.ok(
      captures.some((item) => item.status === "partial" && item.domLength > 0),
      JSON.stringify(captures),
    );
    const metrics = await page.evaluate(() => window.__metrics);
    assert.ok(metrics.filter((item) => item.kind === "snapshot").length >= 3);
    assert.ok(
      metrics.every(
        (item) =>
          Object.values(item).every((value) =>
            ["number", "boolean", "string"].includes(typeof value),
          ) && !("dom" in item),
      ),
    );
    assert.equal(
      await page.evaluate(() => {
        window.__main.stop();
        return window.client.tavernFrameRuntimeRegistry.size();
      }),
      0,
    );
    await assert.rejects(
      page.evaluate(() =>
        window.client.tavernUiService.captureFrameSnapshot({ gameId: "s" }),
      ),
      /没有挂着/,
    );
    assert.deepEqual(errors, []);
  },
);

test(
  "30 轮浏览器内重建 iframe、经公开入口采集并停止：每轮归属正确、旧 frame 注销、无残留",
  { timeout: 180000 },
  async (t) => {
    const { page, errors } = await openPage(t);
    const outcomes = await page.evaluate(
      async (content) => {
        const results = [];
        for (let turn = 1; turn <= 30; turn++) {
          const mounted = window.__mount({
            sessionId: "loop",
            turn,
            partIndex: 0,
            content: content.replace("第 0 行", "第 " + turn + " 轮"),
            eager: true,
            trustedCardMode: true,
            panelId: "p" + turn,
            placement: "message",
          });
          await new Promise((resolve) =>
            mounted.frame.addEventListener("load", resolve, { once: true }),
          );
          const result =
            await window.client.tavernUiService.captureFrameSnapshot({
              gameId: "loop",
              budget: { maxNodes: 60 },
            });
          // 先让请求真正进入文档通道，再卸载，验证在途请求取消而非仅拒绝未就绪入口。
          const staleRequest =
            window.client.tavernUiService.captureFrameSnapshot({
              gameId: "loop",
              turn,
            });
          await Promise.resolve();
          mounted.unmount();
          mounted.stop();
          const stale = await staleRequest.then(
            () => "resolved",
            (error) => error.message,
          );
          results.push({
            turn: result.turn,
            panelId: result.panelId,
            status: result.status,
            token: result.domSnapshot.documentToken === mounted.token,
            nodes: result.domSnapshot.visited.nodes,
            title: /第 \d+ 轮/.exec(result.dom)?.[0],
            stale,
            registry: window.client.tavernFrameRuntimeRegistry.size(),
            frames: document.querySelectorAll("iframe").length,
          });
        }
        return results;
      },
      syntheticContent(20, 5),
    );
    assert.equal(outcomes.length, 30);
    outcomes.forEach((item, index) => {
      assert.equal(item.turn, index + 1);
      assert.equal(item.panelId, "p" + (index + 1));
      assert.equal(item.status, "partial");
      assert.equal(item.token, true);
      assert.equal(item.nodes, 60);
      assert.equal(item.title, "第 " + (index + 1) + " 轮");
      assert.match(item.stale, /已取消|已卸载/);
      assert.deepEqual([item.registry, item.frames], [0, 0]);
    });
    assert.deepEqual(errors, []);
  },
);
