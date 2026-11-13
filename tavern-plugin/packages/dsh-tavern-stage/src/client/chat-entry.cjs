'use strict';
function createStageChatEntry({React, MutationObserver, markdown:TavernColoredMarkdown, enter:navigate, plain:galPlain, blocks:galBlocks, schedule, cancel:cancelTimer}) {
let disposed = false;
const galEnter = (...args) => { if (!disposed) return navigate(...args); };
const cleanups = new Set(), timers = new Set();
function setTimeout(fn, delay) {
    if (disposed) return null;
    const timer = schedule(() => { const active = timers.delete(timer); if (active && !disposed) fn(); }, delay);
    timers.add(timer); return timer;
}
function clearTimeout(timer) { timers.delete(timer); cancelTimer(timer); }
function own(cleanup) {
    let active = true;
    const stop = () => { if (!active) return; active = false; cleanups.delete(stop); cleanup(); };
    if (disposed) stop(); else cleanups.add(stop);
    return stop;
}
// Presentation-only turn navigation. No history read here may start a director task.
// Icon-only: the stage glyph is drawn by CSS (theme.css "chat stage entry"), so the button adds no text to the
// paragraph (copying prose never picks up a label); the tooltip and the accessible name carry the words.
function StageEnterHere(props) {
    return React.createElement('button', { type: 'button', className: 'fork-stage-enter-here', 'aria-label': '从这里进入舞台', title: '从这里进入舞台',
        onClick: event => { event.preventDefault(); event.stopPropagation(); galEnter(props.sessionId, { turn: props.turn, para: props.para }); } });
}
// The entry sits at the end of the bubble's last line: the row renders it (props.enter) inside its text block.
// no portal; each portal container installed React's full delegated listener set.
function StageParagraph(props) {
    const timer = React.useRef(null), root = React.useRef(null);
    const [pressed, setPressed] = React.useState(false);
    React.useLayoutEffect(function () {
        if (!root.current) return;
        root.current.querySelectorAll('p, .fork-bubble').forEach(node => {
            node.setAttribute('data-fork-stage-turn', props.turn); node.setAttribute('data-fork-stage-para', props.para);
        });
    }, [props.turn, props.para, props.children]);
    function cancel() { clearTimeout(timer.current); }
    React.useEffect(() => own(cancel), []);
    return React.createElement('div', { ref: root, className: 'fork-stage-paragraph' + (pressed ? ' is-long-pressed' : ''), 'data-fork-stage-turn': props.turn, 'data-fork-stage-para': props.para,
        onPointerDown: event => { if (event.pointerType !== 'mouse') timer.current = setTimeout(() => setPressed(true), 500); }, onPointerUp: cancel, onPointerCancel: cancel, onPointerMove: cancel },
        props.children);
}
// Keep MarkdownText intact (lists, fenced code, references and footnotes may span blank lines).
// Match rendered reading blocks to source paragraph starts, then end each block with a plain entry button.
// no per-block React portal. Every portal container installs React's full set of
// delegated listeners (~131 per block, ~240k on a long chat); the plain buttons share one click handler on the root.
function galParagraphTargets(blocks, texts, base = 0) {
    const normalize = text => galPlain(text).replace(/[^\p{L}\p{N}]/gu, '');
    const sources = blocks.map(normalize), offsets = [];
    let total = 0;
    sources.forEach(text => { offsets.push(total); total += text.length; });
    const source = sources.join('');
    let cursor = 0, previous = 0;
    return texts.map(text => {
        const value = normalize(text), found = value ? source.indexOf(value, cursor) : -1;
        if (found >= 0) {
            previous = offsets.reduce((at, start, i) => start <= found ? i : at, 0);
            cursor = found + value.length;
        } else {
            previous = offsets.reduce((at, start, i) => start <= cursor ? i : at, 0);
            cursor = (offsets[previous] || 0) + (sources[previous] || '').length;
        }
        return base + previous + 1;
    });
}
function stageEntryButton(doc) {
    // Same element StageEnterHere renders: icon-only, the glyph is CSS.
    const button = doc.createElement('button');
    button.type = 'button'; button.className = 'fork-stage-enter-here';
    button.setAttribute('aria-label', '从这里进入舞台'); button.title = '从这里进入舞台';
    return button;
}
// 混排正文按旧业务段落定位。多个源段落可指向同一完整列表/表格，不拆 DOM 结构。
function bindBodySourceEntries(props) {
    const parent = props.externalRoot, key = String(props.sourceKey);
    const normalize = text => galPlain(text).replace(/[^\p{L}\p{N}]/gu, '');
    const owned = () => [...parent.querySelectorAll('[data-fork-stage-source]')].filter(node => node.getAttribute('data-fork-stage-source') === key);
    let active = true;
    function collect() {
        if (!active || disposed) return;
        const nodes = [...parent.querySelectorAll('p, h1, h2, h3, h4, h5, h6, pre, li, ul, ol, table, blockquote, div, span')]
            .filter(node => !node.closest('[data-tavern-story-dynamic], .fork-bubble') && (node.matches('ul, ol, table') || !node.querySelector('p, pre, li, table, blockquote, div')));
        const wanted = new Set();
        let cursor = 0;
        for (const unit of props.sourceUnits || []) {
            const value = normalize(unit.block || unit.text || '');
            if (!value) continue;
            let index = nodes.findIndex((node, i) => i >= cursor && normalize(node.textContent).includes(value));
            if (index < 0) {
                // 自动排版可把一个源段落拆成多个 p；插件也可移除中间标记。
                // 按源文字顺序归并显示片段，把唯一入口落在最后一个匹配片段。
                let sourceOffset = 0;
                for (let i = cursor; i < nodes.length; i++) {
                    const text = normalize(nodes[i].textContent);
                    if (!text) continue;
                    const found = value.indexOf(text, sourceOffset);
                    if (found < 0) { if (index >= 0) break; continue; }
                    index = i; sourceOffset = found + text.length;
                    if (sourceOffset >= value.length) break;
                }
            }
            if (index < 0) continue;
            cursor = nodes[index].matches('ul, ol, table') ? index : index + 1;
            const container = nodes[index];
            // 完整列表/表格参与源匹配，入口落在末项/末格，不能成为 ul/table 的非法直接子节点。
            const node = container.matches('ul, ol') ? [...container.querySelectorAll('li')].at(-1) || container
                : container.matches('table') ? [...container.querySelectorAll('td, th')].at(-1) || container : container;
            let button = owned().find(button => button.getAttribute('data-fork-stage-para') === String(unit.para));
            if (!button) { button = stageEntryButton(node.ownerDocument); button.setAttribute('data-fork-stage-source', key); button.setAttribute('data-fork-stage-para', unit.para); button.setAttribute('data-fork-stage-turn', props.turn); }
            if (button.parentNode !== node) node.appendChild(button);
            wanted.add(button);
        }
        for (const button of owned()) if (!wanted.has(button)) button.remove();
    }
    function click(event) {
        const button = event.target.closest('[data-fork-stage-source]');
        if (!button || button.getAttribute('data-fork-stage-source') !== key) return;
        event.preventDefault(); event.stopPropagation();
        galEnter(props.sessionId, { turn: props.turn, para: Number(button.getAttribute('data-fork-stage-para')) });
    }
    const observer = new MutationObserver(mutations => {
        const own = node => node.nodeType === 1 && node.matches('.fork-stage-enter-here');
        if (mutations.every(mutation => mutation.type === 'childList' && [...mutation.addedNodes, ...mutation.removedNodes].every(own))) return;
        collect();
    });
    collect(); observer.observe(parent, { childList: true, subtree: true, characterData: true });
    parent.addEventListener('click', click, true);
    return own(() => { active = false; observer.disconnect(); parent.removeEventListener('click', click, true); for (const button of owned()) button.remove(); });
}
function StageMarkdown(props) {
    const root = React.useRef(null), timer = React.useRef(null);
    React.useLayoutEffect(function () {
        if (props.externalRoot) return bindBodySourceEntries(props);
        const parent = root.current;
        if (!parent) return;
        let active = true;
        const marked = new Map();
        function restore(node, before) {
            for (const [key, value] of Object.entries(before.attributes)) {
                if (value === null) node.removeAttribute(key); else node.setAttribute(key, value);
            }
            node.classList.toggle('fork-stage-paragraph', before.paragraph);
            node.classList.toggle('is-long-pressed', before.pressed);
        }
        function collect() {
            if (disposed || !active) return;
            const blocks = galBlocks(props.text);
            const nodes = Array.from(parent.querySelectorAll('p, h1, h2, h3, h4, h5, h6, pre, li, table, blockquote')).filter(node =>
                !node.closest('button') && !node.querySelector('p, pre, li, table, blockquote'));
            // The entry buttons carry no text, so block text is read as is.
            const paras = galParagraphTargets(blocks, nodes.map(node => node.textContent), props.base);
            const targets = new Set(blocks.length ? nodes : []);
            parent.querySelectorAll('.fork-stage-enter-here').forEach(button => { if (!targets.has(button.parentNode)) button.remove(); });
            for (const [node, before] of marked) if (!targets.has(node)) { restore(node, before); marked.delete(node); }
            if (blocks.length) nodes.forEach((node, i) => {
                if (!marked.has(node)) marked.set(node, {
                    attributes:Object.fromEntries(['data-fork-stage-turn','data-fork-stage-para'].map(key => [key,node.getAttribute(key)])),
                    paragraph:node.classList.contains('fork-stage-paragraph'), pressed:node.classList.contains('is-long-pressed')
                });
                const para = paras[i];
                node.classList.add('fork-stage-paragraph'); node.setAttribute('data-fork-stage-turn', props.turn); node.setAttribute('data-fork-stage-para', para);
                const last = node.lastChild;
                if (last && last.nodeType === 1 && last.classList.contains('fork-stage-enter-here')) return;
                const button = node.querySelector(':scope > .fork-stage-enter-here') || stageEntryButton(node.ownerDocument);
                node.appendChild(button);
            });
        }
        collect();
        const observer = new MutationObserver(mutations => {
            const own = node => node.nodeType === 1 && node.matches('.fork-stage-enter-here');
            if (mutations.every(mutation => mutation.target.closest?.('.fork-stage-enter-here') || mutation.type === 'childList' && [...mutation.addedNodes, ...mutation.removedNodes].every(own))) return;
            collect();
        });
        observer.observe(parent, { childList: true, subtree: true, characterData: true });
        return own(() => {
            active = false; observer.disconnect();
            parent.querySelectorAll('.fork-stage-enter-here').forEach(button => button.remove());
            for (const [node, before] of marked) restore(node, before);
            marked.clear();
        });
    }, [props.text, props.turn, props.base, props.externalRoot, props.sourceUnits, props.sourceKey]);
    function cancel() { clearTimeout(timer.current); }
    React.useEffect(() => own(cancel), []);
    // Capture phase: like the former portalled button, the click reaches no Markdown handler in between.
    function enter(event) {
        const button = event.target.closest('.fork-stage-enter-here'), block = button && button.parentNode;
        if (!block || !block.hasAttribute('data-fork-stage-para')) return;
        event.preventDefault(); event.stopPropagation();
        if (disposed) return;
        galEnter(props.sessionId, { turn: props.turn, para: Number(block.getAttribute('data-fork-stage-para')) });
    }
    if (props.externalRoot) return null;
    return React.createElement('div', { ref: root, className: 'fork-stage-markdown', onClickCapture: enter,
        onPointerDown: event => { const node = event.target.closest('[data-fork-stage-para]'); if (node && event.pointerType !== 'mouse') timer.current = setTimeout(() => node.classList.add('is-long-pressed'), 500); },
        onPointerUp: cancel, onPointerMove: cancel, onPointerCancel: cancel },
        React.createElement(TavernColoredMarkdown, props.markdownProps));
}

return {EnterHere:StageEnterHere, Paragraph:StageParagraph, Markdown:StageMarkdown, targets:galParagraphTargets, dispose() {
    if (disposed) return; disposed = true;
    const errors = [];
    for (const stop of [...cleanups, ...[...timers].map(timer => () => clearTimeout(timer))]) { try {stop();} catch (error) {errors.push(error);} }
    if (errors.length) throw new AggregateError(errors, 'Stage chat entry cleanup failed');
}};
}
if (typeof module !== 'undefined' && typeof window === 'undefined') module.exports = {createStageChatEntry};
