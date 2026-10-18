import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const source = await readFile(
  new URL(
    "../tavern-plugin/src/client/runtime/host-artifacts.js",
    import.meta.url,
  ),
  "utf8",
);
const factory = source.slice(
  source.indexOf("function createTavernHostArtifactScope(options)"),
  source.indexOf("const TAVERN_CARD_PHONE_HOST"),
);

const retainedSource = await readFile(
  new URL(
    "../tavern-plugin/src/client/modules/retained-message-frames.js",
    import.meta.url,
  ),
  "utf8",
);
const retentionSource = await readFile(
  new URL(
    "../tavern-plugin/src/client/modules/session-resource-retention.js",
    import.meta.url,
  ),
  "utf8",
);

test("保留帧只在切局停放宿主 UI，离屏卸载不停止脚本，切回复用原实例", () => {
  const dom = new JSDOM("<body><main></main></body>", {
    runScripts: "outside-only",
  });
  try {
    const { window } = dom;
    window.Element.prototype.moveBefore = function (node, child) {
      this.insertBefore(node, child);
    };
    window.eval(
      "function bindTavernFontZoom(){return function(){}}" +
        retentionSource +
        retainedSource +
        ";window.makeRetention=createTavernSessionRetention;window.makeFrames=createRetainedTavernFrames",
    );
    const retention = window.makeRetention({ window });
    const lifecycles = [];
    const frames = window.makeFrames({
      window,
      retention,
      createLifecycle() {
        const life = {
          foreground: [],
          stopped: 0,
          snapshot: () => ({ height: 100 }),
          update() {},
          start: () => () => {
            life.stopped++;
          },
          setForeground(value) {
            life.foreground.push(value);
          },
        };
        lifecycles.push(life);
        return life;
      },
    });
    const home = window.document.querySelector("main"),
      props = {
        sessionId: "A",
        turn: 1,
        partIndex: 0,
        content: "<script>void 0</script>",
      };
    retention.select("A");
    let lease = frames.mount(props, home);
    lease.detach();
    assert.deepEqual(lifecycles[0].foreground, [true]);
    assert.equal(lifecycles[0].stopped, 0);
    retention.select("B");
    assert.deepEqual(lifecycles[0].foreground, [true, false]);
    assert.equal(lifecycles[0].stopped, 0);
    retention.select("A");
    lease = frames.mount(props, home);
    assert.equal(lifecycles.length, 1);
    assert.deepEqual(lifecycles[0].foreground, [true, false, true]);
    frames.clear();
    retention.clear();
    assert.equal(lifecycles[0].stopped, 1);
  } finally {
    dom.window.close();
  }
});

test("文档 scope 独立释放，停放后仍可寻址，释放幂等且拒绝迟到原生代理写入", () => {
  const dom = new JSDOM('<body><main id="shared"></main></body>', {
    runScripts: "outside-only",
  });
  try {
    const { window } = dom;
    window.eval(factory + ";window.makeScope=createTavernHostArtifactScope");
    const old = window.makeScope({
      document: window.document,
      owner: { sessionId: "A", turn: 1, token: "old" },
    });
    const next = window.makeScope({
      document: window.document,
      owner: { sessionId: "A", turn: 1, token: "new" },
    });
    const other = window.makeScope({
      document: window.document,
      owner: { sessionId: "B", turn: 1, token: "other" },
    });
    const nodes = [old, next, other].map((scope, index) => {
      const node = window.document.createElement("button");
      node.id = "owner-" + index;
      scope.mutateRoot(window.document.body, () =>
        window.document.body.append(node),
      );
      return node;
    });
    old.setVisible(false);
    assert.equal(nodes[0].isConnected, false);
    assert.equal(old.findElementById(nodes[0].id), nodes[0]);
    assert.equal(next.findElementById(nodes[0].id), null);
    old.setVisible(true);
    assert.equal(old.findElementById(nodes[0].id), nodes[0]);
    old.dispose();
    old.dispose();
    let mutated = false;
    old.mutateRoot(window.document.body, () => {
      mutated = true;
      nodes[1].remove();
    });
    assert.equal(mutated, false);
    assert.equal(nodes[0].isConnected, false);
    assert.equal(nodes[1].isConnected, true);
    assert.equal(nodes[2].isConnected, true);
    assert.ok(window.document.getElementById("shared"));
    next.dispose();
    other.dispose();
    assert.equal(window.document.body.children.length, 1);
  } finally {
    dom.window.close();
  }
});
