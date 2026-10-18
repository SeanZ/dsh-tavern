function findTavernQuoteRanges(text) {
  // 只匹配同一行内闭合的引号，范围包含定界符。
  const pattern =
    /"[^"\r\n]+"|“[^”\r\n]+”|«[^»\r\n]+»|「[^」\r\n]+」|『[^』\r\n]+』|＂[^＂\r\n]+＂/g;
  return Array.from(String(text).matchAll(pattern), (match) => [
    match.index,
    match.index + match[0].length,
  ]);
}

function installTavernTextColors(root, options, findQuotes) {
  const doc = root.ownerDocument,
    win = doc.defaultView;
  if (!win.CSS || !win.CSS.highlights || typeof win.Highlight !== "function")
    return {
      setEnabled() {},
      setColors() {},
      setActive() {},
      refreshTheme() {},
      dispose() {},
    };
  const prefix = "dsh-tavern-text-" + Math.random().toString(36).slice(2);
  const colors = {
    "quote-light": true,
    "quote-dark": true,
    "em-light": true,
    "em-dark": true,
  };
  const highlights = new Map();
  const style = doc.createElement("style");
  style.setAttribute("data-dsh-tavern-text-colors", "");
  function setColors(overrides) {
    const stylesheet = Object.entries(colors)
      .map(([kind]) => {
        const value =
          overrides && overrides[kind.startsWith("quote") ? "quote" : "em"];
        const color =
          typeof value === "string" &&
          win.CSS.supports("color", value) &&
          !/[;{}]/.test(value)
            ? value
            : "var(--dsw-alias-brand-primary, currentColor)";
        return "::highlight(" + prefix + "-" + kind + "){color:" + color + "}";
      })
      .join("\n");
    if (style.textContent !== stylesheet) style.textContent = stylesheet;
  }
  setColors(options.colors);
  doc.head.appendChild(style);
  for (const kind of Object.keys(colors)) {
    const highlight = new win.Highlight();
    highlight.priority = kind.startsWith("quote") ? 2 : 1;
    highlights.set(kind, highlight);
    win.CSS.highlights.set(prefix + "-" + kind, highlight);
  }
  let enabled = options.enabled !== false,
    active = options.active !== false,
    disposed = false,
    timer = null;
  let observing = false,
    dirty = true;
  const excluded =
    'script,style,textarea,input,select,button,a,code,pre,kbd,samp,svg,math,[hidden],[contenteditable]:not([contenteditable="false"]),[role="button"],[role="textbox"]';
  const blocks = "p,div,li,td,th,blockquote,section,article,h1,h2,h3,h4,h5,h6";
  // 同一次扫描复用祖先样式；下一次扫描重新读取，保留卡片和主题的动态变化。
  let computedColors, explicitColors;
  function computedColor(element) {
    if (!computedColors.has(element))
      computedColors.set(element, win.getComputedStyle(element).color);
    return computedColors.get(element);
  }
  function explicitColor(element) {
    if (explicitColors.has(element)) return explicitColors.get(element);
    const own =
      element.hasAttribute("color") ||
      Boolean(element.style.color || element.style.webkitTextFillColor) ||
      (element.matches("span,font,q,em,i,b,strong,u,mark") &&
        element.parentElement &&
        computedColor(element) !== computedColor(element.parentElement));
    const result = Boolean(
      own ||
      (element !== root &&
        element.parentElement &&
        explicitColor(element.parentElement)),
    );
    explicitColors.set(element, result);
    return result;
  }
  const paletteCache = new Map();
  let canvas;
  function palette(element) {
    const color = computedColor(element);
    if (paletteCache.has(color)) return paletteCache.get(color);
    let rgb = color.match(/[\d.]+/g) || [];
    if (!/^rgba?\(/.test(color)) {
      // 现代主题可能使用 oklch/display-p3，转换为 sRGB 后判断明暗。
      if (!canvas) {
        canvas = doc.createElement("canvas");
        canvas.width = canvas.height = 1;
      }
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context) {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        rgb = context.getImageData(0, 0, 1, 1).data;
      }
    }
    const result =
      Number(rgb[0]) * 0.2126 +
        Number(rgb[1]) * 0.7152 +
        Number(rgb[2]) * 0.0722 >
      145
        ? "dark"
        : "light";
    paletteCache.set(color, result);
    return result;
  }
  function add(kind, entry, start, end) {
    const range = doc.createRange();
    range.setStart(entry.node, start);
    range.setEnd(entry.node, end);
    highlights.get(kind + "-" + entry.palette).add(range);
  }
  function refresh() {
    timer = null;
    if (!running()) return;
    dirty = false;
    for (const highlight of highlights.values()) highlight.clear();
    computedColors = new WeakMap();
    explicitColors = new WeakMap();
    const walker = doc.createTreeWalker(root, 4); // SHOW_TEXT，不修改 React 或卡片持有的 DOM。
    let group = [],
      block = null,
      text = "";
    function flush() {
      for (const [start, end] of findQuotes(text))
        for (const entry of group) {
          const from = Math.max(start, entry.offset),
            to = Math.min(end, entry.offset + entry.node.length);
          if (from < to)
            add("quote", entry, from - entry.offset, to - entry.offset);
        }
      group = [];
      text = "";
    }
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement;
      if (!element || element.closest(excluded) || explicitColor(element)) {
        flush();
        block = null;
        continue;
      }
      const owner = element.closest(blocks) || root;
      // <br> 即使没有换行文本节点，也表示渲染换行。
      if (
        owner !== block ||
        (node.previousSibling && node.previousSibling.nodeName === "BR")
      )
        flush();
      block = owner;
      const entry = { node, offset: text.length, palette: palette(element) };
      group.push(entry);
      text += node.data;
      if (element.closest("q")) add("quote", entry, 0, node.length);
      else if (element.closest("em,i")) add("em", entry, 0, node.length);
    }
    flush();
  }
  function running() {
    return !disposed && enabled && active && doc.visibilityState !== "hidden";
  }
  function cancel() {
    if (timer !== null) win.clearTimeout(timer);
    timer = null;
  }
  function schedule() {
    dirty = true;
    if (running() && timer === null) timer = win.setTimeout(refresh, 32);
  }
  // 根布局属性经常由视口同步写入，只在颜色依赖可能改变时重扫。
  // 未知 class 和 CSS 变量仍保守失效，避免漏掉作者的后代颜色规则。
  function themeStyle(value) {
    const probe = doc.createElement("span").style;
    probe.cssText = value || "";
    return Array.from(probe)
      .filter(
        (name) =>
          name.startsWith("--") ||
          /^(color|color-scheme|-webkit-text-fill-color)$/.test(name),
      )
      .sort()
      .map(
        (name) =>
          name +
          ":" +
          probe.getPropertyValue(name) +
          "!" +
          probe.getPropertyPriority(name),
      )
      .join(";");
  }
  let themeClass = "",
    themeStyles = "";
  function rememberTheme() {
    themeClass = doc.documentElement.getAttribute("class") || "";
    themeStyles = themeStyle(doc.documentElement.getAttribute("style"));
  }
  const observer = new win.MutationObserver(function (records) {
    if (
      records.some(
        (record) =>
          record.target !== doc.documentElement || root === doc.documentElement,
      )
    ) {
      schedule();
      return;
    }
    const nextClass = doc.documentElement.getAttribute("class") || "";
    const nextStyles = themeStyle(doc.documentElement.getAttribute("style"));
    if (nextClass !== themeClass || nextStyles !== themeStyles) schedule();
    themeClass = nextClass;
    themeStyles = nextStyles;
  });
  function sync() {
    if (!running()) {
      observer.disconnect();
      observing = false;
      cancel();
      dirty = true;
      return;
    }
    if (!observing) {
      rememberTheme();
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["style", "class", "color", "hidden"],
      });
      if (options.observeTheme !== false && doc.documentElement !== root)
        observer.observe(doc.documentElement, {
          attributes: true,
          attributeFilter: ["style", "class"],
        });
      observing = true;
    }
    if (dirty) schedule();
  }
  doc.addEventListener("visibilitychange", sync);
  // 批量挂载后再读取样式，避免每条消息插入样式表都强制刷新布局。
  sync();
  return {
    setColors,
    refreshTheme: schedule,
    setActive(value) {
      const next = value !== false;
      if (next === active || disposed) return;
      active = next;
      sync();
    },
    setEnabled(value) {
      const next = value !== false;
      if (next === enabled || disposed) return;
      enabled = next;
      sync();
      if (!enabled)
        for (const highlight of highlights.values()) highlight.clear();
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      cancel();
      doc.removeEventListener("visibilitychange", sync);
      for (const kind of highlights.keys())
        win.CSS.highlights.delete(prefix + "-" + kind);
      style.remove();
    },
  };
}

// 显示颜色由宿主主题提供，忽略旧的浏览器级覆盖设置。
function tavernTextColorsEnabled() {
  return true;
}
function tavernTextColorOverrides(host) {
  const doc = host.document;
  const probe = doc.createElement("span");
  probe.style.cssText =
    "position:absolute;visibility:hidden;color:var(--dsw-alias-brand-primary, currentColor)";
  doc.body.appendChild(probe);
  const accent = host.getComputedStyle(probe).color;
  probe.remove();
  return { quote: accent, em: accent };
}
// 普通正文共享一个观察器；iframe 使用宿主已有的临近视区通道。
const tavernTextColorVisibility = new Map();
let tavernTextColorIntersection = null;
function subscribeTavernTextColorVisibility(root, listener) {
  const win = root.ownerDocument.defaultView;
  if (typeof win.IntersectionObserver !== "function") {
    listener(true);
    return function () {};
  }
  if (!tavernTextColorIntersection)
    tavernTextColorIntersection = new win.IntersectionObserver(
      function (entries) {
        for (const entry of entries) {
          const notify = tavernTextColorVisibility.get(entry.target);
          if (notify) notify(entry.isIntersecting === true);
        }
      },
      { rootMargin: "240px 0px" },
    );
  tavernTextColorVisibility.set(root, listener);
  listener(false);
  tavernTextColorIntersection.observe(root);
  return function () {
    tavernTextColorVisibility.delete(root);
    tavernTextColorIntersection.unobserve(root);
    if (!tavernTextColorVisibility.size) {
      tavernTextColorIntersection.disconnect();
      tavernTextColorIntersection = null;
    }
  };
}
function TavernColoredMarkdown(props) {
  const root = React.useRef(null);
  React.useEffect(function () {
    const win = root.current.ownerDocument.defaultView;
    const colors = installTavernTextColors(
      root.current,
      { active: false, observeTheme: false },
      findTavernQuoteRanges,
    );
    const stopVisibility = subscribeTavernTextColorVisibility(
      root.current,
      (value) => colors.setActive(value),
    );
    const stopTheme = subscribeTavernHostTheme(win, function () {
      colors.refreshTheme();
    });
    return () => {
      stopVisibility();
      stopTheme();
      colors.dispose();
    };
  }, []);
  return React.createElement(
    "div",
    { ref: root, className: "dsh-tavern-colored-markdown" },
    React.createElement(DshUi.MarkdownText, props),
  );
}
