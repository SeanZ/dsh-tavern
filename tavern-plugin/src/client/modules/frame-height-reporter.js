// 在消息 iframe 内运行。保留未知卡片的完整兼容扫描，只在单次测量内复用读取结果。
// eslint-disable-next-line no-unused-vars -- 由 frame-document.js 注入 iframe 使用。
function installTavernFrameHeightReporter(
  token,
  viewportFloor,
  useViewportFloor,
) {
  let last = 0,
    queued = null,
    active = true,
    generation = 0;
  let lastFrame = 0,
    lastGap = null,
    lockGap = null;
  function measure() {
    const body = document.body;
    if (!body) return 48;
    const styles = new WeakMap(),
      rects = new WeakMap();
    const reads = {
      style(node) {
        let style = styles.get(node);
        if (!style) {
          style = getComputedStyle(node);
          styles.set(node, style);
        }
        return style;
      },
      rect(node) {
        let rect = rects.get(node);
        if (!rect) {
          rect = node.getBoundingClientRect();
          rects.set(node, rect);
        }
        return rect;
      },
    };
    const bodyRect = reads.rect(body),
      scrollY = window.scrollY || 0;
    let height = Math.max(
      body.scrollHeight || 0,
      Math.ceil(bodyRect.bottom + scrollY),
      48,
      useViewportFloor === false ? 0 : viewportFloor(reads),
    );
    function visit(node, clipTop, clipBottom) {
      let style;
      try {
        style = reads.style(node);
      } catch {
        return;
      }
      if (style.display === "none") return;
      if (style.visibility !== "hidden" && style.position !== "fixed") {
        const rect = reads.rect(node);
        if (rect.width !== 0 || rect.height !== 0) {
          const top = Math.max(rect.top, clipTop);
          const bottom = Math.min(
            rect.bottom + Math.max(0, parseFloat(style.marginBottom) || 0),
            clipBottom,
          );
          if (bottom > top)
            height = Math.max(height, Math.ceil(bottom + scrollY));
        }
      }
      if (
        String(style.overflowY || style.overflow || "visible") !== "visible"
      ) {
        const own = reads.rect(node);
        clipTop = Math.max(clipTop, own.top);
        clipBottom = Math.min(clipBottom, own.bottom);
        if (clipBottom <= clipTop) return;
      }
      let children = node.children;
      if (
        String(node.tagName || "").toLowerCase() === "details" &&
        !node.open
      ) {
        const summary = node.querySelector("summary");
        children = summary ? [summary] : [];
      }
      for (let i = 0; i < children.length; i++)
        visit(children[i], clipTop, clipBottom);
    }
    visit(body, -Infinity, Infinity);
    return height;
  }
  function report() {
    queued = null;
    const root = document.documentElement;
    if (!active || !root) return;
    const frame = window.innerHeight;
    let height = measure();
    const gap = height - frame;
    // 标题加 100vh 没有能自洽的 iframe 高度，保留既有反馈锁并改用内部滚动。
    if (lockGap !== null && Math.abs(gap - lockGap) > 1) lockGap = null;
    if (
      lockGap === null &&
      gap > 1 &&
      lastGap !== null &&
      frame !== lastFrame &&
      Math.abs(gap - lastGap) <= 1
    )
      lockGap = gap;
    lastFrame = frame;
    lastGap = gap;
    if (lockGap !== null) height = frame;
    root.toggleAttribute(
      "data-dsh-tavern-scroll",
      height >= 32000 || lockGap !== null,
    );
    if (height === last) return;
    last = height;
    parent.postMessage({ type: "dsh-tavern-frame-height", token, height }, "*");
  }
  function schedule() {
    if (!active || queued !== null) return;
    const current = generation;
    const run = function () {
      if (current === generation) report();
    };
    queued =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(run)
        : setTimeout(run, 0);
  }
  function cancel() {
    generation += 1;
    if (queued !== null) {
      if (typeof requestAnimationFrame === "function") {
        if (typeof cancelAnimationFrame === "function")
          cancelAnimationFrame(queued);
      } else clearTimeout(queued);
    }
    queued = null;
  }
  const observer =
    typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
  addEventListener("load", schedule);
  addEventListener("toggle", schedule, true);
  if (document.fonts && document.fonts.ready)
    document.fonts.ready.then(schedule);
  const paintOnly = {
    transform: 1,
    "transform-origin": 1,
    translate: 1,
    rotate: 1,
    scale: 1,
    opacity: 1,
    color: 1,
    "background-color": 1,
    filter: 1,
    "box-shadow": 1,
  };
  function layoutChanged(record) {
    if (record.type === "characterData") return false;
    if (record.type === "childList") {
      const nodes = Array.from(record.addedNodes).concat(
        Array.from(record.removedNodes),
      );
      return nodes.some((node) => node.nodeType !== 3);
    }
    if (record.oldValue === record.target.getAttribute(record.attributeName))
      return false;
    if (record.attributeName !== "style") return true;
    const after = record.target.style;
    if (!after) return true;
    const before = document.createElement("span").style;
    before.cssText = record.oldValue || "";
    const names = Array.from(before).concat(Array.from(after));
    for (const name of names) {
      if (paintOnly[name]) continue;
      if (
        before.getPropertyValue(name) !== after.getPropertyValue(name) ||
        before.getPropertyPriority(name) !== after.getPropertyPriority(name)
      )
        return true;
    }
    return false;
  }
  const mutations = new MutationObserver(function (records) {
    if (records.some(layoutChanged)) schedule();
  });
  function observe() {
    const root = document.documentElement;
    if (!root) return;
    mutations.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
    });
    if (observer) {
      observer.observe(root);
      if (document.body) observer.observe(document.body);
    }
  }
  addEventListener("message", function (event) {
    const data = event.data;
    if (
      event.source !== parent ||
      !data ||
      data.token !== token ||
      data.type !== "dsh-tavern-frame-measure-active"
    )
      return;
    active = data.active !== false;
    if (active) {
      observe();
      schedule();
    } else {
      cancel();
      mutations.disconnect();
      if (observer) observer.disconnect();
    }
  });
  observe();
  schedule();
}
