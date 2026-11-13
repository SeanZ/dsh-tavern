// 纯字符串转换；浏览器和服务端使用同一工厂，各自提供正式 Showdown 依赖。
function createTavernBodyMarkdown(showdown) {
  const containers = new Set('div section article aside main header footer nav figure center details'.split(' '));
  const blocks = new Set(('address blockquote dd dl dt figcaption h1 h2 h3 h4 h5 h6 hr li menu ol p pre table tbody td tfoot th thead tr ul summary ' + [...containers].join(' ')).split(' '));
  const rawTags = new Set(['script', 'style', 'textarea', 'pre', 'code']);
  const voidTags = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
  const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const converter = new showdown.Converter({
    emoji: true, literalMidWordUnderscores: true, parseImgDimensions: true,
    tables: true, underline: true, simpleLineBreaks: true, strikethrough: true,
    disableForced4SpacesIndentedSublists: true,
    extensions: [() => [{ type: 'output',
      regex: /(<code(?:\s+[^>]*)?>[\s\S]*?<\/code>|<style(?:\s+[^>]*)?>[\s\S]*?<\/style>|<[^>]*>)|\b(?<!_)_(?!_)(.*?)(?<!_)_(?!_)\b/gi,
      replace: (match, tag, text) => tag || (text ? '<em>' + text + '</em>' : match)
    }]]
  });
  const tagPattern = /<!--[\s\S]*?(?:-->|$)|<\/?([a-z][\w:-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*?>/gi;
  const controlPattern = /\s+markdown\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  function stripControls(source) {
    return source.replace(tagPattern, token => token.replace(controlPattern, ''));
  }
  // 等长遮罩仅屏蔽 Markdown 代码，不改变任何原文坐标。
  function codeMask(source) {
    const chars = source.split('');
    const hide = (start, end) => { for (let i = start; i < end; i++) if (chars[i] !== '\n') chars[i] = ' '; };
    let offset = 0, fence = null, previousBlank = true, indented = false;
    for (const line of source.split(/(?<=\n)/)) {
      const match = line.match(/^[ \t]*(`{3,}|~{3,})(.*)/);
      if (fence) {
        hide(offset, offset + line.length);
        if (match && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = null;
      } else if (match && !(match[1][0] === '`' && match[2].includes('`'))) { fence = match[1]; hide(offset, offset + line.length); }
      else {
        indented = /^(?: {4}|\t)/.test(line) && (previousBlank || indented) && !/^\s*<\//.test(line);
        if (indented) hide(offset, offset + line.length);
      }
      previousBlank = !line.trim();
      offset += line.length;
    }
    const inline = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;
    let match;
    const inlineSource = chars.join('');
    while ((match = inline.exec(inlineSource))) hide(match.index, inline.lastIndex);
    return chars.join('');
  }
  function convert(source, defaults, inlineOnly = false, unwrapParagraph = false) {
    const mask = codeMask(source);
    const tokens = [...mask.matchAll(new RegExp(tagPattern.source, 'gi'))];
    let prefix = 'DSHBODYOPAQUE';
    while (source.includes(prefix)) prefix += 'X';
    const slots = [];
    const stash = (html, block) => {
      const key = prefix + slots.length + 'END'; slots.push({ key, html, block });
      return block ? '\n\n' + key + '\n\n' : key;
    };
    let out = '', cursor = 0;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i], start = token.index, opening = source.slice(start, start + token[0].length);
      const tag = (token[1] || '').toLowerCase();
      if (start < cursor) continue;
      let escapes = 0; for (let k = start - 1; k >= 0 && source[k] === '\\'; k--) escapes++;
      if (escapes % 2) { out += source.slice(cursor, start - 1) + stash(escape(opening), false); cursor = start + opening.length; continue; }
      if (/^<\//.test(opening)) continue;
      if (!tag) { out += source.slice(cursor, start) + stash(/-->$/.test(opening) ? opening : escape(opening), false); cursor = start + opening.length; continue; }
      if (!blocks.has(tag) && !rawTags.has(tag)) continue;
      let end = start + opening.length, closeStart = end, matched = voidTags.has(tag) || /\/\s*>$/.test(opening);
      if (!matched) {
        if (rawTags.has(tag)) {
          const close = new RegExp('</' + tag + '\\s*>', 'gi'); close.lastIndex = end;
          const found = close.exec(source);
          if (found) { closeStart = found.index; end = close.lastIndex; matched = true; }
        } else {
          let depth = 1;
          for (let j = i + 1; j < tokens.length; j++) {
            const next = tokens[j];
            if ((next[1] || '').toLowerCase() !== tag) continue;
            if (/^<\//.test(next[0])) depth--;
            else if (!/\/\s*>$/.test(next[0])) depth++;
            if (depth === 0) { closeStart = next.index; end = next.index + next[0].length; matched = true; break; }
          }
        }
      }
      out += source.slice(cursor, start);
      if (!matched) { out += stash(escape(source.slice(start)), true); cursor = source.length; break; }
      const whole = source.slice(start, end);
      let html;
      if (rawTags.has(tag)) html = opening.replace(controlPattern, '') + source.slice(start + opening.length, end);
      else {
        const attr = [...opening.matchAll(new RegExp(controlPattern.source, 'gi'))][0];
        const control = attr ? (attr[1] ?? attr[2] ?? attr[3]).replace(/\/$/, '') : null;
        const lineStart = source.lastIndexOf('\n', start - 1) + 1;
        const lineEnd = source.indexOf('\n', end);
        const standalone = !source.slice(lineStart, start).trim() && !source.slice(end, lineEnd < 0 ? source.length : lineEnd).trim();
        const enabled = containers.has(tag) && control !== '0' && (control === '1' || (defaults && standalone));
        if (!enabled) html = stripControls(whole);
        else {
          let inner = source.slice(start + opening.length, closeStart);
          // 容器结构的缩进不应被解释为额外代码块；显式围栏仍受代码遮罩保护。
          inner = inner.replace(/^\n/, '').replace(/\n[ \t]*$/, '');
          const indents = inner.split('\n').filter(line => line.trim()).map(line => (line.match(/^ */) || [''])[0].length);
          const indent = indents.length ? Math.min(...indents) : 0;
          if (indent) inner = inner.split('\n').map(line => line.slice(indent)).join('\n');
          let summary = '';
          if (tag === 'details') {
            const match = inner.match(/^(\s*)<summary\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/summary\s*>/i);
            if (match) { const control = [...match[2].matchAll(new RegExp(controlPattern.source, 'gi'))][0]; const disabled = control && (control[1] ?? control[2] ?? control[3]) === '0'; summary = '<summary' + match[2].replace(controlPattern, '') + '>' + (disabled ? stripControls(match[3]) : convert(match[3], false, true)) + '</summary>'; inner = inner.slice(match[0].length); }
          }
          const rendered = convert(inner, false, false, !inner.includes('\n'));
          html = opening.replace(controlPattern, '') + summary + rendered + source.slice(closeStart, end);
        }
      }
      out += stash(html, blocks.has(tag) && tag !== 'code'); cursor = end;
    }
    out += source.slice(cursor);
    // 完整 HTML 自动链接交给 Showdown，流式半标签只作为字面文本。
    out = out.replace(/<(?=[a-z!/])[^>\n]*$/i, value => escape(value));
    let html = converter.makeHtml(out);
    const singleParagraph = /^<p>((?:(?!<\/?p\b)[\s\S])*)<\/p>$/;
    if (unwrapParagraph || inlineOnly) html = html.replace(singleParagraph, '$1');
    for (const slot of slots) {
      if (slot.block) html = html.replace('<p>' + slot.key + '</p>', () => slot.html);
      html = html.split(slot.key).join(slot.html);
    }
    if (inlineOnly) {
      const inline = html;
      if (/<\/?(?:p|div|section|article|ul|ol|li|h[1-6]|blockquote|pre|table|details)\b/i.test(inline)) return escape(source);
      return inline;
    }
    return html;
  }
  return (source, options = {}) => {
    let input = String(source ?? '').replace(/\r\n?/g, '\n');
    let prefix = 'DSHBODYPORTAL';
    while (input.includes(prefix)) prefix += 'X';
    const mounts = [];
    // 只有调用方登记的槽可以穿过未闭合容器的字面转义，普通作者 HTML 仍按原规则处理。
    for (const id of options.slots || []) {
      if (!/^[a-zA-Z0-9-]+$/.test(id)) continue;
      const marker = '<span data-dsh-body-slot="' + id + '"></span>';
      const key = prefix + mounts.length + 'END';
      if (input.includes(marker)) { input = input.split(marker).join(key); mounts.push({ key, marker }); }
    }
    let html = convert(input, true);
    for (const { key, marker } of mounts) html = html.split(key).join(marker);
    return html;
  };
}
module.exports = { createTavernBodyMarkdown };
