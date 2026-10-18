import { readFile } from "node:fs/promises";
import { browserReactScript } from "./browser-react.mjs";

// 通过可选源码路径对照旧实现；只使用公开的合成正文，不读取业务聊天。
const source = await readFile(
  process.env.TAVERN_TEXT_COLORS_SOURCE ||
    new URL("../../tavern-plugin/src/client/text-colors.js", import.meta.url),
  "utf8",
);
const theme = await readFile(
  new URL(
    "../../tavern-plugin/src/client/modules/host-theme.js",
    import.meta.url,
  ),
  "utf8",
);
const { chromium } = await import(
  process.env.TAVERN_PLAYWRIGHT_MODULE || "playwright"
);
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {},
);
try {
  const rounds = [];
  for (let run = 0; run < 5; run++) {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await page.setContent(
      "<style>body{margin:0;color:#222;--dsw-alias-brand-primary:#123456}article{height:400px;overflow:hidden}p{margin:0}</style><main></main>",
    );
    await page.addScriptTag({ content: await browserReactScript() });
    const instrumented = source.replace(
      "function refresh() {",
      `function refresh() {const start=performance.now();try{return refreshInner();}finally{scanMetrics.scans++;scanMetrics.times.push(performance.now()-start);}}function refreshInner() {`,
    );
    await page.addScriptTag({
      content: `const React=modules.react;const DshUi={MarkdownText:props=>React.createElement('article',null,...Array.from({length:20},(_,i)=>React.createElement('p',{key:i},'旁白“',React.createElement('b',null,props.text),'朋友”',React.createElement('em',null,'心声'))))};
      window.resetMetrics=()=>window.scanMetrics={scans:0,textNodes:0,styleReads:0,times:[]};resetMetrics();
      const walk=document.createTreeWalker.bind(document);document.createTreeWalker=(...args)=>{const walker=walk(...args),next=walker.nextNode.bind(walker);walker.nextNode=()=>{const node=next();if(node)scanMetrics.textNodes++;return node};return walker};
      const read=window.getComputedStyle;window.getComputedStyle=(...args)=>{scanMetrics.styleReads++;return read(...args)};
      ${instrumented}\n${theme}
      window.reactRoot=modules['react-dom/client'].createRoot(document.querySelector('main'));
      window.renderMessages=text=>reactRoot.render(React.createElement(React.Fragment,null,...Array.from({length:32},(_,i)=>React.createElement(TavernColoredMarkdown,{key:i,text:text+i}))));
      renderMessages('合成对白');`,
    });
    await page.waitForTimeout(250);
    const initial = await page.evaluate(() => structuredClone(scanMetrics));
    await page.evaluate(() => resetMetrics());
    for (let event = 0; event < 5; event++) {
      await page.evaluate(() => {
        document.documentElement.setAttribute("class", "");
        document.documentElement.style.height = "100%";
      });
      await page.waitForTimeout(80);
    }
    const unrelated = await page.evaluate(() => structuredClone(scanMetrics));
    await page.evaluate(() => {
      resetMetrics();
      renderMessages("流式新对白");
    });
    await page.waitForTimeout(300);
    const stream = await page.evaluate(() => structuredClone(scanMetrics));
    await page.evaluate(() => {
      resetMetrics();
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      renderMessages("后台新对白");
    });
    await page.waitForTimeout(300);
    const hidden = await page.evaluate(() => structuredClone(scanMetrics));
    rounds.push({ initial, unrelated, stream, hidden });
    await page.close();
  }
  console.log(
    JSON.stringify({
      browser: browser.version(),
      viewport: "390x844",
      paragraphs: "32x20",
      visibility: "合成 visibilitychange 信号，非实际系统后台",
      rounds,
    }),
  );
} finally {
  await browser.close();
}
