import assert from "node:assert/strict";
import test from "node:test";
import { browserReactScript } from "./fixtures/browser-react.mjs";
import {
  cardLibraryContext,
  cardLibrarySource,
  cardListSource,
} from "./fixtures/card-library-harness.mjs";

test(
  "真实 React 人物卡页签：普通会话打开、模式切换、列表/宫格、引用和详情读取",
  {
    skip: !process.env.TAVERN_BROWSER_TESTS,
    timeout: 45000,
  },
  async () => {
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
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setContent(
        '<button id="open-tab">人物卡</button><div id="root"></div>',
      );
      await page.addScriptTag({ content: await browserReactScript() });
      await page.addScriptTag({
        content: `
      const React = modules.react;
      const options = {mode: undefined, cards: [{path: "cards/example.json", name: "合成人物卡"}], calls: [], toggled: [], managing: false};
      window.options = options;
      Object.assign(window, (${cardLibraryContext.toString()})(React, options));
      ${cardListSource}
      ${cardLibrarySource}
      class Boundary extends React.Component {
        state = {error: ""};
        static getDerivedStateFromError(error) { return {error: error.message}; }
        render() { return this.state.error ? React.createElement("p", {"data-error": true}, "dsh-better-sidebar: " + this.state.error) : this.props.children; }
      }
      const root = modules["react-dom/client"].createRoot(document.getElementById("root"));
      window.mentions = [];
      window.renderTab = () => root.render(React.createElement(Boundary, null,
        React.createElement(CardLibraryTab, {visible: true, scope: {sessionId: "synthetic-session"}, tab: {id: "cards"},
          ctx: {betterSidebar: {updateTab() {}}}, appendMention: (...args) => window.mentions.push(args)})));
      document.getElementById("open-tab").onclick = window.renderTab;
    `,
      });
      await page.click("#open-tab");
      await page.waitForSelector("[data-error], .dsh-tavern-library-card");
      assert.equal(
        await page.locator("[data-error]").count(),
        0,
        (await page.locator("[data-error]").allTextContents()).join("\n"),
      );
      assert.equal(await page.locator(".dsh-tavern-card-mention").count(), 0);
      for (const mode of ["story", "card", "standard"]) {
        await page.evaluate((mode) => {
          options.mode = mode;
          renderTab();
        }, mode);
        await page.waitForFunction(
          (mode) =>
            document.querySelectorAll(".dsh-tavern-card-mention").length ===
            (mode === "card" ? 1 : 0),
          mode,
        );
        if (mode === "card") {
          await page.click(".dsh-tavern-card-mention");
          assert.deepEqual(await page.evaluate(() => mentions), [
            ["cards/example.json", "合成人物卡"],
          ]);
          assert.equal(await page.locator("[data-card-detail]").count(), 0);
        }
        await page.getByRole("button", { name: "宫格", exact: true }).click();
        await page.waitForSelector(".dsh-tavern-card-grid-open");
        assert.equal(
          await page.locator(".dsh-tavern-card-mention").count(),
          mode === "card" ? 1 : 0,
        );
        await page.getByRole("button", { name: "列表", exact: true }).click();
        await page.waitForSelector(".dsh-tavern-library-card");
      }
      await page.click(".dsh-tavern-library-card");
      await page.waitForSelector('[data-card-detail="cards/example.json"]');
      assert.ok(
        await page.evaluate(() =>
          options.calls.some(
            (call) =>
              call.method === "getCard" &&
              call.args.path === "cards/example.json",
          ),
        ),
      );
      await page.getByRole("button", { name: "返回", exact: true }).click();
      await page.waitForSelector(".dsh-tavern-library-card");
      await page.evaluate(() => {
        options.mode = "card";
        options.managing = true;
        renderTab();
      });
      await page.waitForFunction(
        () => !document.querySelector(".dsh-tavern-card-mention"),
      );
      await page.click(".dsh-tavern-library-card");
      assert.deepEqual(await page.evaluate(() => options.toggled), [
        "cards/example.json",
      ]);
      assert.equal(await page.locator("[data-card-detail]").count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);
