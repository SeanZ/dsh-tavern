import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../../tavern-plugin/lib/client.js", import.meta.url),
  "utf8",
);
function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
export const cardLibrarySource = section(
  "function CardLibraryTab(props)",
  "function CardFieldsPanel(props)",
);
const listStart = source.indexOf(
  'const TAVERN_CARD_LIST_VIEW_KEY = "dsh-tavern-card-list-view";',
);
const listEnd =
  source.indexOf(
    "\n\t\t}\n",
    source.indexOf("function TavernCardList(props)", listStart),
  ) + 4;
assert.ok(listStart >= 0 && listEnd > listStart);
export const cardListSource = source.slice(listStart, listEnd);

// 只替换数据接口和相邻功能；人物卡页签及列表渲染使用实际构建源码。
export function cardLibraryContext(React, options) {
  const h = React.createElement;
  const batch = {
    get managing() {
      return Boolean(options.managing);
    },
    checkbox: () => null,
    isSelected: () => false,
    toggle: (path) => options.toggled.push(path),
  };
  return {
    React,
    useTavernConfirm: () => () => {},
    useTavernSessionMode: () => options.mode,
    usePersistentError: () => React.useState(""),
    useCardBatchDeletion: () => batch,
    useCardOrganization: (cards) => ({
      visible: cards,
      renderCards: (render) => cards.map(render),
      rowMenu: () => h("button", { className: "test-menu" }, "菜单"),
      toolbar: () => null,
      addCardsFooter: () => null,
      detailSettings: () => ({}),
    }),
    createCardLibraryRefreshModule: () => ({
      load: (_path, load) => load(),
      activate: (load) => load(),
      dispose() {},
    }),
    rpcWithTimeout: async (method, args) => {
      options.calls.push({ method, args });
      if (method === "listCards") return { cards: options.cards };
      if (method === "getCard")
        return { card: options.cards.find((card) => card.path === args.path) };
      throw new Error("非预期的人物卡读取接口");
    },
    TavernCardListContent: ({ card }) => h("span", null, card.name),
    CardFieldsPanel: ({ view, onBack }) =>
      h(
        "section",
        { "data-card-detail": view.card.path },
        h("span", null, view.card.name),
        h("button", { onClick: onBack }, "返回"),
      ),
    MobileCardImportButton: () => null,
    useTavernUiExtensions() {},
    tavernUiExtensions: { cardListViews: () => [] },
    tavernPluginBoundary: () => React.Fragment,
    tavernDataChangeAffects: () => false,
  };
}
