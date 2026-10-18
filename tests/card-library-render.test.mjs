import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  cardLibraryContext,
  cardLibrarySource,
  cardListSource,
} from "./fixtures/card-library-harness.mjs";

const card = { path: "cards/example.json", name: "合成人物卡" };
function render(mode, managing = false, view = "") {
  const options = { mode, managing, cards: [card], calls: [], toggled: [] };
  let stateIndex = 0;
  const React = {
    Fragment: "fragment",
    createElement(type, props, ...children) {
      return typeof type === "function"
        ? type({ ...props, children })
        : { type, props: props || {}, children: children.flat(Infinity) };
    },
    useState(initial) {
      const value =
        stateIndex++ === 0
          ? options.cards
          : typeof initial === "function"
            ? initial()
            : initial;
      return [value, () => {}];
    },
    useRef: (current) => ({ current }),
    useEffect() {},
  };
  const context = {
    ...cardLibraryContext(React, options),
    window: { localStorage: { getItem: () => view } },
  };
  const Tab = vm.runInNewContext(
    cardListSource + cardLibrarySource + ";CardLibraryTab",
    context,
  );
  const mentions = [];
  const tree = Tab({
    visible: true,
    scope: { sessionId: "synthetic-session" },
    appendMention: (...args) => mentions.push(args),
  });
  const nodes = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    nodes.push(node);
    for (const child of node.children || []) visit(child);
  }
  visit(tree);
  return { nodes, options, mentions };
}

for (const mode of [undefined, "story", "standard", "card"]) {
  for (const view of ["", "dsh-tavern:grid"]) {
    test(`人物卡库渲染：${mode || "未加载模式"} / ${view || "列表"}`, () => {
      const result = render(mode, false, view);
      const mention = result.nodes.filter(
        (n) => n.props.className === "dsh-tavern-card-mention",
      );
      assert.equal(mention.length, mode === "card" ? 1 : 0);
      assert.ok(result.nodes.some((n) => n.children.includes(card.name)));
      if (mode === "card") {
        let stopped = false;
        mention[0].props.onClick({
          stopPropagation() {
            stopped = true;
          },
        });
        assert.equal(stopped, true);
        assert.deepEqual(result.mentions, [[card.path, card.name]]);
      }
    });
  }
}

test("批量管理时隐藏引用按钮，点击人物卡只切换选择", () => {
  for (const mode of ["story", "card"]) {
    const result = render(mode, true);
    assert.equal(
      result.nodes.some((n) => n.props.className === "dsh-tavern-card-mention"),
      false,
    );
    result.nodes
      .find((n) => n.props.className === "dsh-tavern-library-card")
      .props.onClick();
    assert.deepEqual(result.options.toggled, [card.path]);
    assert.deepEqual(result.options.calls, []);
  }
});
