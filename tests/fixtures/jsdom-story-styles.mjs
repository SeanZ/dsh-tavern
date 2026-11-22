// jsdom 的选择器引擎无法解析上游抽屉规则中嵌套的 :is/:has。
// 此夹具只用于无侧栏的故事 DOM 测试；抽屉布局由 Chromium 回归验证。
export function omitUnsupportedSidebarRule(document) {
  for (const sheet of document.styleSheets) {
    for (let index = sheet.cssRules.length - 1; index >= 0; index--) {
      const selector = sheet.cssRules[index].selectorText || ''
      if (!selector.includes(':has(') && !selector.includes(':is(')) continue
      try { document.documentElement.matches(selector) }
      catch { sheet.deleteRule(index) }

    }
  }
}
