// 复用故事快照的重建清洗边界；正文禁止控件，旧快照可显式保留禁用控件。
  const TAVERN_FLOOR_TAGS = new Set(["div", "span", "p", "img", "br", "hr", "b", "strong", "i", "em", "u", "s", "small", "sub", "sup", "mark", "del", "ins", "q", "cite", "abbr", "time", "blockquote", "pre", "code", "kbd",
    "ul", "ol", "li", "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col", "h1", "h2", "h3", "h4", "h5", "h6", "a",
    "details", "summary", "section", "article", "aside", "header", "footer", "nav", "main", "figure", "figcaption", "center", "style", "button", "input", "label", "progress", "meter"]);
  const TAVERN_FLOOR_DROPPED = new Set(["svg", "math", "script", "iframe", "frame", "frameset", "object", "embed", "applet", "template", "form", "link", "meta", "base", "noscript", "portal", "textarea", "select"]);
  const TAVERN_FLOOR_ATTRIBUTES = new Set(["class", "id", "style", "title", "alt", "src", "href", "width", "height", "colspan", "rowspan", "span", "open", "disabled", "checked", "value", "type", "role", "lang", "dir", "align", "min", "max", "low", "high", "optimum", "datetime", "start", "reversed", "for"]);
  const TAVERN_FLOOR_INPUT_TYPES = new Set(["text", "checkbox", "radio", "range", "number", "button"]);
  function tavernFloorUrl(value, image) {
    const url = String(value || "").replace(/[\u0000- \u007f]/g, "");
    if (/^https?:/i.test(url)) return true;
    if (image && /^data:image\//i.test(url)) return true;
    // Relative: no scheme at all (and not protocol-relative).
    return !/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^[\\/]{2}/.test(url);
  }
  // CSS that cannot load or run anything: no imports, legacy script hooks or script/non-image URLs.
  function cleanTavernFloorCss(css) {
    return String(css || "").replace(/<\/?style/gi, "")
      .replace(/@import\b[^;]*;?/gi, "")
      .replace(/expression\s*\(/gi, "(")
      .replace(/(?:behavior|-moz-binding)\s*:[^;}]*;?/gi, "")
      .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, function (match, _quote, value) {
        const url = value.trim();
        return /\\/.test(url) || /^(?:javascript|vbscript):/i.test(url) || /^data:/i.test(url) && !/^data:image\//i.test(url) ? "none" : match;
      });
  }
  function tavernFloorDynamicNode(node) {
    return node.nodeType === 1 && (node.classList.contains("dsh-tavern-plugin-media") || node.hasAttribute("data-tavern-story-dynamic"));
  }
  function sanitizeTavernBodyHtml(html, doc, { mode = 'untrusted', slots = [], snapshot = false, controls = false } = {}) {
    if (!['trusted', 'untrusted', 'static'].includes(mode)) throw new TypeError('未知正文清洗模式');
    const allowedSlots = new Set(slots), usedSlots = new Set();
    const template = doc.createElement("template");
    template.innerHTML = String(html || "");
    const output = doc.createElement("template");
    function copy(source, target) {
      for (const node of Array.from(source.childNodes)) {
        if (snapshot && tavernFloorDynamicNode(node)) continue;
        if (node.nodeType === 3) { target.appendChild(doc.createTextNode(node.data)); continue; }
        // The truncation marker of a bounded snapshot is the only comment kept.
        if (node.nodeType === 8) { if (node.data === " 已截断 ") target.appendChild(doc.createComment(node.data)); continue; }
        if (node.nodeType !== 1) continue;
        const tag = node.localName;
        if (node.namespaceURI !== "http://www.w3.org/1999/xhtml" || TAVERN_FLOOR_DROPPED.has(tag)) continue;
        if (!controls && ['button', 'input', 'label', 'progress', 'meter'].includes(tag)) continue;
        if (!TAVERN_FLOOR_TAGS.has(tag)) { copy(node, target); continue; }
        const element = doc.createElement(tag);
        if (tag === "style") {
          if (mode !== "static") continue;
          element.textContent = cleanTavernFloorCss(node.textContent).replace(/(^|[{},]\s*)(?:html|body|:root)(?=[\s,{.:#\[>~+]|$)/g, "$1:host");
          target.appendChild(element);
          continue;
        }
        const slot = node.getAttribute('data-dsh-body-slot');
        if (tag === 'span' && allowedSlots.has(slot) && !usedSlots.has(slot)) {
          usedSlots.add(slot); element.setAttribute('data-dsh-body-slot', slot); target.appendChild(element); continue;
        }
        if (mode === 'untrusted' && ['td', 'th'].includes(tag) && /^(left|right|center)$/.test(node.style.textAlign)) element.setAttribute('align', node.style.textAlign);
        for (const attr of Array.from(node.attributes)) {
          const name = attr.name.toLowerCase();
          if (name.startsWith('data-dsh-body-') || (!snapshot && name === 'data-tavern-story-dynamic')) continue;
          if (mode === 'untrusted' && ['id', 'class', 'style', 'for'].includes(name)) continue;
          if (mode === 'untrusted' && name === 'href' && !/^https?:/i.test(attr.value.replace(/[\u0000- \u007f]/g, ''))) continue;
          if (!(TAVERN_FLOOR_ATTRIBUTES.has(name) || /^(?:data|aria)-[a-z0-9_.-]+$/.test(name))) continue;
          if ((name === "src" || name === "href") && !tavernFloorUrl(attr.value, name === "src" && tag === "img")) continue;
          if (name === "type" && tag === "input" && !TAVERN_FLOOR_INPUT_TYPES.has(attr.value.toLowerCase())) continue;
          element.setAttribute(name, name === "style" ? cleanTavernFloorCss(attr.value) : attr.value);
        }
        if (tag === "a" && element.hasAttribute("href")) { element.setAttribute("target", "_blank"); element.setAttribute("rel", "noopener noreferrer"); }
        if (tag === "button" || tag === "input") { element.setAttribute("disabled", ""); if (tag === "button") element.setAttribute("type", "button"); }
        copy(node, element);
        target.appendChild(element);
      }
    }
    copy(template.content, output.content);
    return output.innerHTML;
  }

module.exports = { sanitizeTavernBodyHtml };
