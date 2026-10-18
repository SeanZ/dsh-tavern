// 视口尺寸卡片无法自行确定 iframe 高度，沿用宿主视口下限并保留卡片内部滚动。
function tavernFrameViewportFloor(reads) {
  const readStyle = reads ? reads.style : (node) => getComputedStyle(node);
  const readRect = reads ? reads.rect : (node) => node.getBoundingClientRect();
  var viewport = 600;
  try {
    viewport = window.parent.innerHeight || viewport;
  } catch (_) {}
  viewport = Math.max(160, Math.min(1200, viewport));
  function viewportHeight(style) {
    return /(?:^|[^\d.])100(?:d|s|l)?vh\b/i.test(
      (style.height || "") + " " + (style.minHeight || ""),
    );
  }
  function visible(node) {
    // 嵌入适配器将文档根恢复为内容高度，body/html 的旧规则不能作为视口面板。
    if (node === document.body || node === document.documentElement)
      return false;
    for (
      var ancestor = node.parentElement;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      if (ancestor.tagName === "DETAILS" && !ancestor.open) {
        var summary = ancestor.querySelector("summary");
        if (!summary || !summary.contains(node)) return false;
      }
    }
    var rect = readRect(node);
    var style = readStyle(node);
    return (
      rect.width > window.innerWidth / 2 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  }
  function matchesRules(rules) {
    for (var rule of Array.from(rules || [])) {
      if (rule.media && !matchMedia(rule.media.mediaText).matches) continue;
      if (rule.selectorText && rule.style && viewportHeight(rule.style)) {
        try {
          if (
            Array.from(document.querySelectorAll(rule.selectorText)).some(
              visible,
            )
          )
            return true;
        } catch (_) {}
      }
      if (rule.cssRules && matchesRules(rule.cssRules)) return true;
    }
    return false;
  }
  for (var sheet of Array.from(document.styleSheets)) {
    try {
      if (
        !sheet.disabled &&
        (!sheet.media.mediaText || matchMedia(sheet.media.mediaText).matches) &&
        matchesRules(sheet.cssRules)
      )
        return viewport;
    } catch (_) {}
  }
  for (var node of document.body.querySelectorAll("*")) {
    // 先检查不依赖几何的条件，再测量可见性。
    var style = readStyle(node);
    // 全屏固定面板没有普通流高度；小浮动按钮和对话框不能撑高 iframe。
    if (
      !viewportHeight(node.style) &&
      !(
        style.position === "fixed" &&
        style.top === "0px" &&
        style.bottom === "0px"
      )
    )
      continue;
    if (visible(node)) return viewport;
  }
  return 0;
}
