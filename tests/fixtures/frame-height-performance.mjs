import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

export async function heightClient() {
  const source = await readFile(
    process.env.TAVERN_HEIGHT_CLIENT_SOURCE ||
      new URL("../../tavern-plugin/lib/client.js", import.meta.url),
    "utf8",
  );
  let descriptor;
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load(value) {
          descriptor = value;
        },
      },
    },
  });
  const client = descriptor.factory(() => ({}));
  return client;
}
export async function heightReporter(input = {}) {
  const client = await heightClient();
  const html = client.buildTavernFrameDocument({
    token: "height-performance",
    content: "",
    runtimeReporting: false,
    ...input,
  });
  return html.match(/<script data-dsh-tavern-frame>([\s\S]*?)<\/script>/)?.[1];
}

export async function measureHeightPerformance() {
  const tools = await import(
    process.env.TAVERN_PLAYWRIGHT_MODULE || "playwright"
  );
  const engine = process.env.TAVERN_BROWSER_ENGINE || "chromium";
  const browser = await tools[engine].launch(
    process.env.TAVERN_BROWSER_EXECUTABLE
      ? { executablePath: process.env.TAVERN_BROWSER_EXECUTABLE }
      : {},
  );
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await page.setContent(
      '<iframe style="width:360px;height:180px;border:0"></iframe>',
    );
    const reporter = (await heightReporter()).replace(
      /function measure\(\)\s*\{/,
      "function measure(){const start=performance.now();try{return measureInner();}finally{heightMetrics.times.push(performance.now()-start);}}function measureInner(){",
    );
    await page.evaluate((reporter) => {
      window.heightReports = [];
      addEventListener("message", (event) => {
        if (event.data?.type === "dsh-tavern-frame-height")
          heightReports.push(event.data.height);
      });
      const content =
        "<style>body{margin:0}.clip{height:40px;overflow:hidden;margin-bottom:2px}p{margin:0;height:20px}</style>" +
        Array.from(
          { length: 300 },
          () => '<section class="clip"><p><span>合成正文</span></p></section>',
        ).join("");
      const probe = `window.resetHeightMetrics=()=>window.heightMetrics={styles:0,rects:0,times:[]};resetHeightMetrics();
        const read=window.getComputedStyle;window.getComputedStyle=(...args)=>{heightMetrics.styles++;return read(...args)};
        const rect=Element.prototype.getBoundingClientRect;Element.prototype.getBoundingClientRect=function(){heightMetrics.rects++;return rect.call(this)};`;
      document.querySelector("iframe").srcdoc =
        content +
        "<script>" +
        probe +
        "</" +
        "script><script>" +
        reporter +
        "</" +
        "script>";
    }, reporter);
    const frame = page.frames()[1];
    await frame.waitForFunction(() => window.resetHeightMetrics);
    await page.waitForTimeout(180);
    const samples = [];
    for (let i = 0; i < 5; i++) {
      await frame.evaluate(() => resetHeightMetrics());
      await page.evaluate(() =>
        document.querySelector("iframe").contentWindow.postMessage(
          {
            type: "dsh-tavern-frame-measure-active",
            token: "height-performance",
            active: true,
          },
          "*",
        ),
      );
      await page.waitForTimeout(100);
      const sample = await frame.evaluate(() => ({
        ...heightMetrics,
        height: document.body.scrollHeight,
        elements: document.body.querySelectorAll("*").length + 1,
      }));
      sample.reportedHeight = await page.evaluate(() => heightReports.at(-1));
      assert.ok(sample.times.length > 0, "实际高度测量已经执行");
      samples.push(sample);
    }
    return {
      browser: browser.version(),
      viewport: "390x844",
      sections: 300,
      samples,
    };
  } finally {
    await browser.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(JSON.stringify(await measureHeightPerformance()));
}
