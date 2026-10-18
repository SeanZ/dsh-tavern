import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { chromium, webkit } from "playwright";
import { assembleTavernClient } from "../bin/build-tavern-client.mjs";

// 使用实际消息文档、生命周期和 iframe 脚本，不读取任何用户数据。
test("普通可信消息按文档回收宿主节点和 jQuery 事件，切局保留脚本状态", async (t) => {
  const client = await assembleTavernClient();
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://fixture").pathname;
    if (pathname === "/")
      return response.end(
        '<!doctype html><body><button id="shared">共享宿主按钮</button>',
      );
    if (
      pathname.endsWith("/zod/index.mjs") ||
      pathname.endsWith("/yaml/index.mjs")
    ) {
      response.setHeader("Content-Type", "text/javascript");
      return response.end("export default {};");
    }
    const prefix = "/api/dsh-tavern/vendor/runtime-assets/";
    if (pathname.startsWith(prefix) && !pathname.includes("..")) {
      try {
        const bytes = await readFile(
          new URL(
            "../tavern-plugin/lib/vendor/runtime-assets/" +
              pathname.slice(prefix.length),
            import.meta.url,
          ),
        );
        response.setHeader(
          "Content-Type",
          pathname.endsWith(".css") ? "text/css" : "text/javascript",
        );
        return response.end(bytes);
      } catch {}
    }
    response.statusCode = 404;
    response.end("");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const engine =
    process.env.PLAYWRIGHT_TEST_ENGINE === "webkit" ? webkit : chromium;
  const browser = await engine.launch({
    executablePath: process.env.PLAYWRIGHT_TEST_EXECUTABLE_PATH || undefined,
  });
  t.after(() => browser.close());
  t.diagnostic("浏览器：" + engine.name() + " " + browser.version());
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.evaluate((client) => {
    window.__ModuleLoader__ = {
      load(descriptor) {
        window.client = descriptor.factory(() => ({}));
      },
    };
    window.eval(client);
    window.owners = new Map();
    window.calls = [];
    window.rpcCalls = [];
    window.writes = {};
    window.localSelections = {};
    window.nativeCalls = [];
    window.rawNodes = [];
    window.rawHandlers = [];
    window.fixture = {
      content(id) {
        return (
          '<div id="collision">local</div><script type="module">await window.__dshTavernHelperReady;' +
          "const host=parent;const id=" +
          JSON.stringify(id) +
          ";" +
          '$(host.document.body).append(`<button id="collision" data-fixture-owner="${id}">${id}</button>`);' +
          '$(host.document.getElementById("shared")).append(`<span data-fixture-child="${id}">${id}</span>`);' +
          '$(host.document).on("fixture-owned.same",()=>host.calls.push(id));' +
          '$(host.document.getElementById("shared")).on("fixture-shared.same",()=>host.calls.push(id));' +
          'const root=$(host.document.body);host.late=host.late||{};host.late[id]=()=>root.append(`<aside data-fixture-owner="${id}">late</aside>`);' +
          'host.writes[id]=()=>window.replaceVariables({late:id},{type:"chat"});' +
          'host.localSelections[id]=()=>$("#collision").toArray().map(node=>node.textContent);' +
          '$(host.document.querySelector(`[data-fixture-owner="${id}"]`)).on("fixture-parked",()=>host.calls.push(id));' +
          'const raw=host.document.createElement("aside");raw.dataset.rawOwner=id;host.document.body.append(raw);host.rawNodes.push(raw);' +
          'const rawHandler=()=>host.nativeCalls.push(id);host.document.addEventListener("fixture-native",rawHandler);host.rawHandlers.push(rawHandler);' +
          "host.started=host.started||{};host.started[id]=true;" +
          "</" +
          "script>"
        );
      },
      create(id, sessionId = "A", turn = 1) {
        const props = {
          content: this.content(id),
          sessionId,
          turn,
          partIndex: 0,
          trustedCardMode: true,
          runtimeReporting: false,
          helperContext: {
            version: 1,
            stateRevision: 1,
            lifecycleRevision: 1,
            messages: [{ message_id: 0, message: "fixture", variables: {} }],
            turnMessageIds: { [turn]: 0 },
          },
        };
        const lifecycle = window.client.createTavernMessageFrameLifecycle(
          props,
          {
            window,
            rpc: async (...args) => {
              rpcCalls.push(args);
              return {};
            },
          },
        );
        const frames = new Map();
        function paint(state) {
          const wanted = [state.visibleDocument, state.pendingDocument].filter(
            Boolean,
          );
          for (const [token, entry] of frames)
            if (!wanted.some((doc) => doc.token === token)) {
              entry.doc.ref(null);
              entry.frame.remove();
              frames.delete(token);
            }
          for (const doc of wanted)
            if (!frames.has(doc.token)) {
              const frame = document.createElement("iframe");
              frame.className = "dsh-tavern-message-frame";
              frame.srcdoc = doc.html;
              document.body.append(frame);
              doc.ref(frame);
              frames.set(doc.token, { doc, frame });
            }
        }
        paint(lifecycle.snapshot());
        const stop = lifecycle.start(paint);
        const owner = { lifecycle, frames, props, stop, activeId: id };
        owners.set(id, owner);
        return owner;
      },
      replace(id, next) {
        const owner = owners.get(id);
        owner.props = { ...owner.props, content: this.content(next) };
        owner.activeId = next;
        owner.lifecycle.update(owner.props);
      },
      remove(id) {
        const owner = owners.get(id);
        owner.stop();
        owner.stop();
        writes[owner.activeId]?.().catch(() => {});
        document.dispatchEvent(new Event("fixture-native"));
        for (const { doc, frame } of owner.frames.values()) {
          doc.ref(null);
          frame.remove();
        }
        owners.delete(id);
      },
      fire() {
        document.dispatchEvent(new Event("fixture-owned"));
      },
      count(id) {
        return document.querySelectorAll('[data-fixture-owner="' + id + '"]')
          .length;
      },
    };
  }, client);
  await page.evaluate(() => fixture.create("old"));
  await page.waitForFunction(() => window.started?.old);
  assert.equal(await page.evaluate(() => fixture.count("old")), 1);
  await page.evaluate(() =>
    owners
      .get("old")
      .frames.values()
      .next()
      .value.frame.contentWindow.replaceVariables(
        { ok: true },
        { type: "chat" },
      ),
  );
  const activeWrites = await page.evaluate(() => rpcCalls.length);
  assert.ok(activeWrites > 0);
  await page.evaluate(() => fixture.create("other", "B"));
  await page.waitForFunction(() => window.started?.other);
  // 两个文档短暂并存，且 turn 相同，必须按 token 独立回收。
  await page.evaluate(() => fixture.create("new"));
  await page.waitForFunction(() => window.started?.new);
  await page.evaluate(() => fixture.remove("old"));
  assert.equal(
    await page.evaluate(() => fixture.count("old")),
    0,
    "撤回后宿主浮层应被回收",
  );
  assert.equal(await page.locator('[data-fixture-child="old"]').count(), 0);
  assert.equal(await page.locator("#shared").count(), 1);
  assert.equal(
    await page
      .locator('[data-fixture-child="new"],[data-fixture-child="other"]')
      .count(),
    2,
  );
  assert.equal(await page.evaluate(() => fixture.count("new")), 1);
  assert.equal(await page.evaluate(() => fixture.count("other")), 1);
  await page.evaluate(() => {
    late.old();
    fixture.fire();
    document.dispatchEvent(new Event("fixture-native"));
  });
  // 裸 parent 原生 API 不经托管入口，不能把旁观者的 DOM/监听器误收为本实例资源。
  assert.equal(await page.locator('[data-raw-owner="old"]').count(), 1);
  assert.ok(await page.evaluate(() => nativeCalls.includes("old")));
  assert.equal(
    await page.evaluate(() => fixture.count("old")),
    0,
    "迟到托管挂载不能复活旧文档",
  );
  assert.deepEqual(await page.evaluate(() => calls.sort()), ["new", "other"]);
  await page.evaluate(() => {
    window.savedPanel = document.querySelector('[data-fixture-owner="new"]');
    owners.get("new").lifecycle.setForeground(false);
  });
  assert.equal(await page.evaluate(() => fixture.count("new")), 0);
  assert.deepEqual(await page.evaluate(() => localSelections.new()), ["local"]);
  await page.evaluate(() => late.new());
  assert.equal(await page.evaluate(() => fixture.count("new")), 0);
  await page.evaluate(() => owners.get("new").lifecycle.setForeground(true));
  assert.equal(await page.evaluate(() => fixture.count("new")), 2);
  assert.ok(
    await page.evaluate(
      () => document.querySelector('[data-fixture-owner="new"]') === savedPanel,
    ),
  );
  await page.evaluate(() => {
    calls.length = 0;
    document
      .getElementById("shared")
      .dispatchEvent(new Event("fixture-shared"));
  });
  assert.deepEqual(await page.evaluate(() => calls.sort()), ["new", "other"]);
  await page.evaluate(() => {
    const owner = owners.get("new");
    const frame = owner.frames.values().next().value.frame;
    window.foreignClicks = 0;
    frame.contentWindow
      .jQuery(savedPanel)
      .on("fixture-parked", () => foreignClicks++);
    owner.lifecycle.setForeground(false);
    owner.stop();
    calls.length = 0;
    savedPanel.dispatchEvent(new Event("fixture-parked"));
  });
  assert.deepEqual(await page.evaluate(() => calls), []);
  assert.equal(await page.evaluate(() => foreignClicks), 1);
  await page.evaluate(() => fixture.remove("new"));
  const samples = [];
  for (let i = 0; i < 30; i++) {
    const id = "cycle-" + i;
    await page.evaluate((id) => fixture.create(id), id);
    await page.waitForFunction((id) => window.started?.[id], id);
    const successor = id + "-replacement";
    await page.evaluate(({ id, successor }) => fixture.replace(id, successor), {
      id,
      successor,
    });
    await page.waitForFunction(
      (successor) => window.started?.[successor],
      successor,
    );
    await page.waitForFunction(
      (id) => owners.get(id).lifecycle.snapshot().pendingDocument === null,
      id,
    );
    assert.equal(await page.evaluate((id) => fixture.count(id), id), 0);
    await page.evaluate(
      ({ id, successor }) => {
        late[id]();
        owners.get(id).lifecycle.setForeground(false);
        late[successor]();
        owners.get(id).lifecycle.setForeground(true);
        fixture.remove(id);
        late[successor]();
        calls.length = 0;
        fixture.fire();
      },
      { id, successor },
    );
    assert.deepEqual(await page.evaluate(() => calls), ["other"]);
    samples.push(
      await page.evaluate(() => ({
        frames: document.querySelectorAll("iframe").length,
        artifacts: document.querySelectorAll("[data-fixture-owner]").length,
        sharedChildren: document.querySelectorAll("[data-fixture-child]")
          .length,
      })),
    );
  }
  assert.ok(
    samples.every(
      (sample) =>
        sample.frames === 1 &&
        sample.artifacts === 1 &&
        sample.sharedChildren === 1,
    ),
  );
  t.diagnostic(
    "30 周期资源基线（另一会话保持活跃）：" + JSON.stringify(samples.at(-1)),
  );
  await page.evaluate(() => {
    fixture.remove("other");
    for (const node of rawNodes) node.remove();
    for (const handler of rawHandlers)
      document.removeEventListener("fixture-native", handler);
    calls.length = 0;
    fixture.fire();
  });
  assert.deepEqual(await page.evaluate(() => calls), []);
  assert.equal(await page.evaluate(() => rpcCalls.length), activeWrites);
  assert.equal(
    await page
      .locator("iframe,[data-fixture-owner],[data-fixture-child]")
      .count(),
    0,
  );

  await t.test(
    "真实保留帧接线在切局后恢复原 iframe，撤回释放所有资源",
    async (t) => {
      if (
        !(await page.evaluate(
          () => typeof document.body.moveBefore === "function",
        ))
      ) {
        t.skip("当前引擎没有 moveBefore，实际 UI 不启用 retained frame 分支");
        return;
      }
      await page.evaluate(() => {
        const home = document.createElement("main");
        document.body.append(home);
        const retention = client.createTavernSessionRetention({ window });
        const frames = client.createRetainedTavernFrames({
          window,
          retention,
          createLifecycle: (props) =>
            client.createTavernMessageFrameLifecycle(props, {
              window,
              rpc: async () => ({}),
            }),
        });
        const props = {
          sessionId: "retained-A",
          turn: 1,
          partIndex: 0,
          frameOwner: {},
          trustedCardMode: true,
          runtimeReporting: false,
          helperContext: { version: 1, stateRevision: 1, messages: [] },
          content:
            '<input value="initial"><script type="module">await window.__dshTavernHelperReady;const host=parent;host.retainedRuns=(host.retainedRuns||0)+1;const button=$(\'<button id="retained-overlay">保留面板</button>\');$(host.document.body).append(button);button.on("click",()=>host.retainedClicks=(host.retainedClicks||0)+1);host.retainedStarted=true;</' +
            "script>",
        };
        retention.select("retained-A");
        window.retained = {
          home,
          retention,
          frames,
          props,
          lease: frames.mount(props, home),
        };
      });
      await page.waitForFunction(() => window.retainedStarted === true);
      await page.evaluate(() => {
        window.retainedFrame = retained.home.querySelector("iframe");
        window.retainedWindow = retainedFrame.contentWindow;
        window.retainedOverlay = document.getElementById("retained-overlay");
        retainedFrame.contentDocument.querySelector("input").value =
          "preserved";
        retained.lease.detach();
      });
      assert.equal(
        await page.locator("#retained-overlay").count(),
        1,
        "离屏卸载仍保留面板语义",
      );
      await page.evaluate(() => retained.retention.select("retained-B"));
      assert.equal(await page.locator("#retained-overlay").count(), 0);
      assert.ok(
        await page.evaluate(
          () =>
            retainedFrame.isConnected && retained.frames.has(retained.props),
        ),
      );
      await page.evaluate(() => {
        retained.retention.select("retained-A");
        retained.lease = retained.frames.mount(retained.props, retained.home);
      });
      assert.ok(
        await page.evaluate(
          () =>
            retained.home.querySelector("iframe") === retainedFrame &&
            retainedFrame.contentWindow === retainedWindow,
        ),
      );
      assert.equal(
        await page.evaluate(
          () => retainedFrame.contentDocument.querySelector("input").value,
        ),
        "preserved",
      );
      assert.ok(
        await page.evaluate(
          () => document.getElementById("retained-overlay") === retainedOverlay,
        ),
      );
      assert.equal(
        await page.evaluate(() => retainedRuns),
        1,
        "回局不重复执行脚本",
      );
      await page.locator("#retained-overlay").click();
      assert.equal(await page.evaluate(() => retainedClicks), 1);
      // 撤回沿用既有 frameOwner 失效入口，不添加新的消息状态源。
      await page.evaluate(() => {
        retained.frames.invalidateOwner(retained.props.frameOwner);
        retained.retention.clear();
        retainedOverlay.click();
      });
      assert.equal(await page.locator("#retained-overlay").count(), 0);
      assert.equal(await page.evaluate(() => retainedFrame.isConnected), false);
      assert.equal(await page.evaluate(() => retainedClicks), 1);
    },
  );
});
