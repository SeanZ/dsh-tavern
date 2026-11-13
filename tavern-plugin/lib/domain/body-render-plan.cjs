// frameIndex 保留旧投影过滤后的坐标，sourcePartIndex 仅用于正文源位置映射。
function bodyHtmlHasPresentation(value) {
  const source = String(value || '').trim();
  if (!source) return false;
  if (/<(?:script|style|link|iframe|object|embed|img|picture|video|audio|canvas|svg|br|hr|input|button|select|textarea|progress|meter)\b/i.test(source)) return true;
  const text = source.replace(/<!--[\s\S]*?-->/g, '');
  if (text.replace(/<[^>]*>/g, '').trim()) return true;
  return (text.match(/<[a-z][\w:-]*(?:\s[^<>]*?)?\/?\s*>/gi) || []).some(tag => /^<[a-z][\w:-]*\s+[^>]*>/i.test(tag) && !/^<[a-z][\w:-]*\s*\/?>$/i.test(tag));
}
const bodyPresentationTags = new Set('div span p img br hr b strong i em u s del small sub sup blockquote pre code ul ol li dl dt dd table thead tbody tfoot tr td th caption colgroup col h1 h2 h3 h4 h5 h6 a details summary section article figure figcaption aside main header footer nav center'.split(' '));
function isBodyPresentationHtml(content) {
  if (/<!doctype|<\/?(?:html|head|body)\b|\s(?:on[\w:-]+|srcdoc|is)\s*=/i.test(content)) return false;
  const tags = String(content).matchAll(/<\/?([a-z][\w:-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*?>/gi);
  for (const tag of tags) if (!bodyPresentationTags.has(tag[1].toLowerCase())) return false;
  return true;
}
function createBodyRenderPlan(projection) {
  if (!projection) return [];
  const parts = Array.isArray(projection.parts) ? projection.parts :
    [{ kind: projection.mode === 'html' || projection.mode === 'rich' ? 'html' : 'markdown', content: projection.html ?? projection.text, text: projection.text, sourceKind: projection.sourceKind }];
  let nextFrame = 0, group = null;
  const result = [];
  for (const [sourcePartIndex, part] of parts.entries()) {
    if (!part || !['markdown', 'html'].includes(part.kind)) { group = null; continue; }
    const text = String(part.kind === 'html' ? part.content ?? part.html ?? '' : part.text ?? '');
    const visible = part.kind === 'html' ? bodyHtmlHasPresentation(text) : Boolean(text.trim());
    const frameIndex = visible ? nextFrame++ : null;
    if (part.bodyBreakBefore) group = null;
    const boundary = part.kind === 'html' && (part.fenced || part.statusKey || Number.isInteger(part.statusRule) || part.sourceKind === 'rendered' || !isBodyPresentationHtml(text));
    if (boundary) {
      group = null;
      if (visible) result.push({ ...part, content: text, frameIndex, sourcePartIndex });
      continue;
    }
    if (!group) { group = { kind: 'body', text: '', members: [], frameIndex }; result.push(group); }
    if (group.frameIndex === null && frameIndex !== null) group.frameIndex = frameIndex;
    group.members.push({ sourcePartIndex, frameIndex, start: group.text.length, end: group.text.length + text.length });
    group.text += text;
  }
  return result.filter(part => part.kind !== 'body' || part.text.trim());
}
module.exports = { createBodyRenderPlan, isBodyPresentationHtml, bodyHtmlHasPresentation };
