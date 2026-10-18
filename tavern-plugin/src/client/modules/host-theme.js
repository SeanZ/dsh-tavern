// 消息 iframe 和普通正文共享主题观察器。
// DSH 通过 CSS 变量和样式表提供主题，每批变动只读取一次。
const tavernHostThemeListeners = new Set();
let tavernHostThemeObserver = null,
  tavernHostTheme = null;
// 共享主题也承载作者后代选择器的失效；布局属性不影响正文配色。
function tavernHostTextColorContext(win) {
  return JSON.stringify(
    [win.document.documentElement, win.document.body].map(function (node) {
      const style = node.style;
      const values = Array.from(style)
        .filter(
          (name) =>
            name.startsWith("--") ||
            /^(color|color-scheme|-webkit-text-fill-color)$/.test(name),
        )
        .sort()
        .map((name) => [
          name,
          style.getPropertyValue(name),
          style.getPropertyPriority(name),
        ]);
      return [node.getAttribute("class") || "", values];
    }),
  );
}
function tavernAuthorStylesheetChanged(record) {
  function authored(node) {
    if (node.nodeType === 3) node = node.parentElement;
    return Boolean(
      node &&
      node.matches &&
      node.matches(
        'style:not([data-dsh-tavern-text-colors]),link[rel="stylesheet"]',
      ),
    );
  }
  return (
    authored(record.target) ||
    Array.from(record.addedNodes || [])
      .concat(Array.from(record.removedNodes || []))
      .some(authored)
  );
}
function readTavernHostTheme(win) {
  const value = parseFloat(
    win
      .getComputedStyle(win.document.body)
      .getPropertyValue("--dsh-content-font-size"),
  );
  // DSH 在 html 上设置 color-scheme，并通过 body 的 data-ds-dark-theme 标记深色主题。
  return {
    textColorContext: tavernHostTextColorContext(win),
    fontSize: Number.isFinite(value) && value >= 8 && value <= 48 ? value : 14,
    textColorOverrides: tavernTextColorOverrides(win),
    colorScheme: win.document.body.hasAttribute("data-ds-dark-theme")
      ? "dark"
      : "light",
  };
}
function currentTavernHostTheme(win) {
  return tavernHostTheme || readTavernHostTheme(win);
}
function subscribeTavernHostTheme(win, listener) {
  if (!tavernHostThemeObserver) {
    tavernHostTheme = readTavernHostTheme(win);
    // 卡片分批挂载时会插入多张样式表，合并到下一帧读取，避免逐条强制重算样式。
    let queued = false,
      pendingStylesheet = false;
    const schedule = win.requestAnimationFrame
      ? function (work) {
          win.requestAnimationFrame(work);
        }
      : function (work) {
          win.setTimeout(work, 16);
        };
    const observer = new win.MutationObserver(function (records) {
      pendingStylesheet =
        pendingStylesheet || records.some(tavernAuthorStylesheetChanged);
      if (queued) return;
      queued = true;
      schedule(function () {
        queued = false;
        if (tavernHostThemeObserver !== observer) return;
        const next = readTavernHostTheme(win);
        const stylesheetChanged = pendingStylesheet;
        pendingStylesheet = false;
        if (
          !stylesheetChanged &&
          next.textColorContext === tavernHostTheme.textColorContext &&
          next.fontSize === tavernHostTheme.fontSize &&
          next.textColorOverrides.quote ===
            tavernHostTheme.textColorOverrides.quote &&
          next.colorScheme === tavernHostTheme.colorScheme
        )
          return;
        tavernHostTheme = next;
        tavernHostThemeListeners.forEach(function (notify) {
          notify(next);
        });
      });
    });
    tavernHostThemeObserver = observer;
    tavernHostThemeObserver.observe(win.document.head, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    [win.document.documentElement, win.document.body]
      .filter(Boolean)
      .forEach(function (node) {
        tavernHostThemeObserver.observe(node, {
          attributes: true,
          attributeFilter: ["style", "class", "data-ds-dark-theme"],
        });
      });
  }
  tavernHostThemeListeners.add(listener);
  return function () {
    tavernHostThemeListeners.delete(listener);
    if (tavernHostThemeListeners.size || !tavernHostThemeObserver) return;
    tavernHostThemeObserver.disconnect();
    tavernHostThemeObserver = null;
    tavernHostTheme = null;
  };
}

// 保留卡片内部排版，只缩放插件持有的容器；iframe 视口同比缩小，避免视口单位溢出。
function bindTavernFontZoom(node, win) {
  function apply(theme) {
    node.style.zoom = theme.fontSize === 14 ? "" : String(theme.fontSize / 14);
  }
  const unsubscribe = subscribeTavernHostTheme(win, apply);
  apply(currentTavernHostTheme(win));
  return function () {
    unsubscribe();
    node.style.zoom = "";
  };
}
