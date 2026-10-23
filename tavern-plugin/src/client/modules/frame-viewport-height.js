// 一次高度采样内同一节点的样式与几何只读一次；采样结束即丢弃，下次采样重新读取。
// 以源码注入 iframe，只能使用自身作用域内的名字。
// eslint-disable-next-line no-unused-vars -- 由客户端拼接入口及 frame 脚本调用。
function createTavernLayoutSample() {
	var styles = new Map(), rects = new Map();
	return {
		style: function (node) {
			if (!styles.has(node)) styles.set(node, getComputedStyle(node));
			return styles.get(node);
		},
		rect: function (node) {
			if (!rects.has(node)) rects.set(node, node.getBoundingClientRect());
			return rects.get(node);
		}
	};
}

// A viewport-sized card cannot determine its own iframe viewport. Use the host
// viewport as a floor for page layouts, while retaining authored local scrollers.
function tavernFrameViewportFloor(sample) {
	if (!sample) sample = { style: function (node) { return getComputedStyle(node); }, rect: function (node) { return node.getBoundingClientRect(); } };
	var viewport = 600;
	try { viewport = window.parent.innerHeight || viewport; } catch (_) {}
	viewport = Math.max(160, Math.min(1200, viewport));
	function viewportHeight(style) {
		return /(?:^|[^\d.])100(?:d|s|l)?vh\b/i.test((style.height || '') + ' ' + (style.minHeight || ''));
	}
	function visible(node) {
        // The embedding adapter resets document roots to content height. An
        // overridden author rule on body/html is not a live viewport-sized panel.
        if (node === document.body || node === document.documentElement) return false;
        for (var ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
            if (ancestor.tagName === 'DETAILS' && !ancestor.open) {
                var summary = ancestor.querySelector('summary');
                if (!summary || !summary.contains(node)) return false;
            }
        }
		var rect = sample.rect(node);
		var style = sample.style(node);
		return rect.width > window.innerWidth / 2 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
	}
	function matchesRules(rules) {
		for (var rule of Array.from(rules || [])) {
			if (rule.media && !matchMedia(rule.media.mediaText).matches) continue;
			if (rule.selectorText && rule.style && viewportHeight(rule.style)) {
				try { if (Array.from(document.querySelectorAll(rule.selectorText)).some(visible)) return true; } catch (_) {}
			}
			if (rule.cssRules && matchesRules(rule.cssRules)) return true;
		}
		return false;
	}
	for (var sheet of Array.from(document.styleSheets)) {
		try { if (!sheet.disabled && (!sheet.media.mediaText || matchMedia(sheet.media.mediaText).matches) && matchesRules(sheet.cssRules)) return viewport; } catch (_) {}
	}
	for (var node of document.body.querySelectorAll('*')) {
		// Check the cheap conditions first; visible() measures layout.
		var style = sample.style(node);
		// Full-page fixed shells have no normal-flow height at all. Floating
		// buttons or small dialogs must not enlarge the frame.
		if (!viewportHeight(node.style) && !(style.position === 'fixed' && style.top === '0px' && style.bottom === '0px')) continue;
		if (visible(node)) return viewport;
	}
	return 0;
}
