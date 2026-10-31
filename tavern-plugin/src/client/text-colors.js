function findTavernQuoteRanges(text) {
    // Match only complete same-line pairs, including the delimiters.
    const pattern = /"[^"\r\n]+"|“[^”\r\n]+”|«[^»\r\n]+»|「[^」\r\n]+」|『[^』\r\n]+』|＂[^＂\r\n]+＂/g;
    return Array.from(String(text).matchAll(pattern), match => [match.index, match.index + match[0].length]);
}

function installTavernTextColors(root, options, findQuotes) {
    const doc = root.ownerDocument, win = doc.defaultView;
    if (!win.CSS || !win.CSS.highlights || typeof win.Highlight !== 'function') return { setEnabled() {}, setColors() {}, dispose() {} };
    // One stylesheet and four named highlights per document, shared by every mounted
    // message: each registered ::highlight name costs style work on every element, so
    // one set per message made each sidebar or layout change recalculate for ~200ms.
    // Kept inside this function because frames receive it as source text.
    const prefix = 'dsh-tavern-text';
    const colors = { 'quote-light': true, 'quote-dark': true, 'em-light': true, 'em-dark': true };
    const shared = win.__dshTavernTextColors || (win.__dshTavernTextColors = { users: 0, style: null, highlights: new Map(), themed: new Set(), theme: null });
    // The page root changes often (layout variables, input modality); only a change of
    // the resolved text colors is a theme change that every message must re-read.
    function themeKey() {
        return win.getComputedStyle(doc.documentElement).colorScheme + '|' + win.getComputedStyle(doc.body || doc.documentElement).color;
    }
    if (!shared.users++) {
        shared.themeKey = themeKey();
        shared.theme = new win.MutationObserver(function () {
            const key = themeKey();
            if (key === shared.themeKey) return;
            shared.themeKey = key;
            shared.themed.forEach(function (schedule) { schedule(); });
        });
        const themeAttributes = { attributes: true, attributeFilter: ['style', 'class', 'data-ds-dark-theme', 'data-ds-theme-source'] };
        shared.theme.observe(doc.documentElement, themeAttributes);
        if (doc.body) shared.theme.observe(doc.body, themeAttributes);
        shared.style = doc.createElement('style');
        shared.style.setAttribute('data-dsh-tavern-text-colors', '');
        doc.head.appendChild(shared.style);
        for (const kind of Object.keys(colors)) {
            const highlight = new win.Highlight();
            highlight.priority = kind.startsWith('quote') ? 2 : 1;
            shared.highlights.set(kind, highlight);
            win.CSS.highlights.set(prefix + '-' + kind, highlight);
        }
    }
    const style = shared.style;
    function setColors(overrides) {
        style.textContent = Object.entries(colors).map(([kind, fallback]) => {
            const value = overrides && overrides[kind.startsWith('quote') ? 'quote' : 'em'];
            const color = typeof value === 'string' && win.CSS.supports('color', value) && !/[;{}]/.test(value)
                ? value : 'var(--dsw-alias-brand-primary, currentColor)';
            return '::highlight(' + prefix + '-' + kind + '){color:' + color + '}';
        }).join('\n');
    }
    if (shared.users === 1 || options.colors) setColors(options.colors);
    // This instance's ranges, so a refresh or dispose removes only its own.
    const owned = [];
    function clearOwned() {
        for (const [kind, range] of owned) shared.highlights.get(kind).delete(range);
        owned.length = 0;
    }
    let enabled = options.enabled !== false, disposed = false, timer = null;
    const excluded = 'script,style,textarea,input,select,button,a,code,pre,kbd,samp,svg,math,[hidden],[contenteditable]:not([contenteditable="false"]),[role="button"],[role="textbox"]';
    const blocks = 'p,div,li,td,th,blockquote,section,article,h1,h2,h3,h4,h5,h6';
    // A refresh reads the same ancestors for many text nodes. Cache only for this
    // synchronous pass so later theme/card mutations always get fresh styles.
    let computedColors, explicitColors;
    function computedColor(element) {
        if (!computedColors.has(element)) computedColors.set(element, win.getComputedStyle(element).color);
        return computedColors.get(element);
    }
    function explicitColor(element) {
        if (explicitColors.has(element)) return explicitColors.get(element);
        const own = element.hasAttribute('color') || Boolean(element.style.color || element.style.webkitTextFillColor)
            || (element.matches('span,font,q,em,i,b,strong,u,mark') && element.parentElement
                && computedColor(element) !== computedColor(element.parentElement));
        const result = Boolean(own || (element !== root && element.parentElement && explicitColor(element.parentElement)));
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
            // Modern themes may use oklch/display-p3; read their sRGB equivalent.
            if (!canvas) { canvas = doc.createElement('canvas'); canvas.width = canvas.height = 1; }
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (context) { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); rgb = context.getImageData(0, 0, 1, 1).data; }
        }
        const result = Number(rgb[0]) * .2126 + Number(rgb[1]) * .7152 + Number(rgb[2]) * .0722 > 145 ? 'dark' : 'light';
        paletteCache.set(color, result);
        return result;
    }
    function add(kind, entry, start, end) {
        const range = doc.createRange();
        range.setStart(entry.node, start); range.setEnd(entry.node, end);
        shared.highlights.get(kind + '-' + entry.palette).add(range);
        owned.push([kind + '-' + entry.palette, range]);
    }
    function refresh() {
        timer = null;
        clearOwned();
        if (disposed || !enabled) return;
        computedColors = new WeakMap(); explicitColors = new WeakMap();
        const walker = doc.createTreeWalker(root, 4); // SHOW_TEXT; never edit React/card-owned DOM.
        let group = [], block = null, text = '';
        function flush() {
            for (const [start, end] of findQuotes(text)) for (const entry of group) {
                const from = Math.max(start, entry.offset), to = Math.min(end, entry.offset + entry.node.length);
                if (from < to) add('quote', entry, from - entry.offset, to - entry.offset);
            }
            group = []; text = '';
        }
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const element = node.parentElement;
            if (!element || element.closest(excluded) || explicitColor(element)) { flush(); block = null; continue; }
            const owner = element.closest(blocks) || root;
            // <br> is a rendered line break even without a newline text node.
            if (owner !== block || (node.previousSibling && node.previousSibling.nodeName === 'BR')) flush();
            block = owner;
            const entry = { node, offset: text.length, palette: palette(element) };
            group.push(entry); text += node.data;
            if (element.closest('q')) add('quote', entry, 0, node.length);
            else if (element.closest('em,i')) add('em', entry, 0, node.length);
        }
        flush();
    }
    function schedule() { if (!disposed && enabled && timer === null) timer = win.setTimeout(refresh, 32); }
    const observer = new win.MutationObserver(schedule);
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style', 'class', 'color', 'hidden'] });
    shared.themed.add(schedule);
    // Batch mounts before reading computed styles; each message adds a stylesheet.
    schedule();
    return {
        setColors,
        setEnabled(value) {
            enabled = value !== false;
            if (timer !== null) win.clearTimeout(timer);
            timer = null;
            if (enabled) schedule();
            else clearOwned();
        },
        dispose() {
            if (disposed) return;
            disposed = true; observer.disconnect(); if (timer !== null) win.clearTimeout(timer);
            clearOwned();
            shared.themed.delete(schedule);
            if (--shared.users) return;
            shared.theme.disconnect();
            shared.theme = null;
            for (const kind of shared.highlights.keys()) win.CSS.highlights.delete(prefix + '-' + kind);
            shared.highlights.clear();
            style.remove();
            shared.style = null;
        }
    };
}

// Display colors belong to the host theme; legacy per-browser overrides are ignored.
function tavernTextColorsEnabled() { return true; }
function tavernTextColorOverrides(host) {
    const doc = host.document;
    const probe = doc.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--dsw-alias-brand-primary, currentColor)';
    doc.body.appendChild(probe);
    const accent = host.getComputedStyle(probe).color;
    probe.remove();
    return { quote: accent, em: accent };
}
function TavernColoredMarkdown(props) {
    const root = React.useRef(null);
    // While a reply streams, every frame rewrites this block's text nodes. Colouring it
    // then means a full subtree walk plus getComputedStyle per node, every Range thrown
    // away and rebuilt, and a document-wide highlight refresh — tens of times a second
    // for a cost that grows with the reply. Colour once, when the text stops changing.
    const streaming = props.streaming === true;
    React.useEffect(function () {
        if (streaming) return undefined;
        const colors = installTavernTextColors(root.current, {}, findTavernQuoteRanges);
        return () => colors.dispose();
    }, [streaming]);
    return React.createElement('div', { ref: root, className: 'dsh-tavern-colored-markdown' }, React.createElement(DshUi.MarkdownText, props));
}
