// 正文只转换一次；动态媒体、代码交互与文件提及挂到本次登记的局部位置。
function TavernBodyMarkdown(props) {
    const root = React.useRef(null);
    const [mounts, setMounts] = React.useState([]);
    const text = String(props.text ?? '');
    const prepared = React.useMemo(() => props.prepared || { text, slots: [] }, [props.prepared, text]);
    const layoutRevision = typeof useTavernProseLayoutRevision === "function" ? useTavernProseLayoutRevision() : 0;
    const html = React.useMemo(() => renderBodyMarkdown(layoutTavernBodyText(prepared.text, props.streaming), { slots: prepared.slots.map(slot => slot.id) }), [prepared.text, props.streaming, layoutRevision]);
    const mode = props.static === true ? 'static' : props.trustedCardMode === true ? 'trusted' : 'untrusted';
    React.useLayoutEffect(function () {
        const host = root.current;
        if (!host) return;
        const doc = host.ownerDocument;
        const surface = props.static ? host.shadowRoot || host.attachShadow({ mode: 'open' }) : host;
        let content = [...surface.children].find(node => node.classList.contains('dsh-tavern-body-content'));
        if (!content) { content = doc.createElement('div'); content.className = 'mes_text dsh-tavern-body-content'; surface.appendChild(content); }
        const template = doc.createElement('template');
        template.innerHTML = sanitizeTavernBodyHtml(html, doc, { mode, slots: prepared.slots.map(slot => slot.id) });
        const next = [];
        for (const [index, pre] of [...template.content.querySelectorAll('pre')].entries()) {
            const code = pre.firstElementChild;
            if (!code || code.localName !== 'code' || !DshUi.CodeBlock) continue;
            const target = doc.createElement('div');
            const id = 'code:' + index;
            target.setAttribute('data-dsh-body-mount', id);
            pre.replaceWith(target);
            next.push({ id, node: React.createElement(DshUi.CodeBlock, { code: code.textContent, lang: (code.className.match(/(?:^|\s)language-([^\s]+)/) || [])[1], streaming: props.streaming === true,
                copyLabel: props.codeLabels?.copyLabel || props.labels?.code?.copyLabel || '复制', copiedLabel: props.codeLabels?.copiedLabel || props.labels?.code?.copiedLabel || '已复制' }) });
        }
        const boundaryTails = new Map();
        for (const slot of prepared.slots) {
            const marker = [...template.content.querySelectorAll('[data-dsh-body-slot]')].find(node => node.getAttribute('data-dsh-body-slot') === slot.id);
            if (!marker) continue;
            const target = doc.createElement(slot.block ? 'div' : 'span');
            target.setAttribute('data-dsh-body-mount', slot.id);
            if (slot.dynamic) target.setAttribute('data-tavern-story-dynamic', '');
            // 块组件移到最小的完整结构之后，避免切断链接、段落、列表或表格。
            let boundary = marker;
            if (slot.block) {
                const invalid = marker.closest('a, p, pre, code, table');
                if (invalid) boundary = invalid.closest('table') || invalid;
            }
            const markerParagraph = marker.parentElement?.localName === 'p' && [...marker.parentElement.childNodes].every(node => node === marker || node.nodeType === 3 && !node.textContent.trim());
            if (slot.block && markerParagraph) marker.parentElement.replaceWith(target);
            else if (boundary === marker) marker.replaceWith(target);
            else {
                (boundaryTails.get(boundary) || boundary).after(target);
                boundaryTails.set(boundary, target);
                marker.remove();
            }
            next.push({ id: slot.id, node: slot.node });
        }
        for (const [index, code] of [...template.content.querySelectorAll('code')].entries()) {
            const mention = props.fileMentions?.resolve?.(code.textContent);
            if (!mention) continue;
            const target = doc.createElement('span'), id = 'file:' + index;
            target.setAttribute('data-dsh-body-mount', id); code.replaceWith(target);
            next.push({ id, node: React.createElement('button', { ...mention.contextMenuProps, type: 'button', title: mention.title, 'aria-label': mention.label, onClick: mention.open }, React.createElement('code', null, code.textContent)) });
        }
        patchTavernBodyDom(content, template.content);
        setMounts(next.map(item => ({ ...item, target: [...content.querySelectorAll('[data-dsh-body-mount]')].find(node => node.getAttribute('data-dsh-body-mount') === item.id) })).filter(item => item.target));
        const colors = installTavernTextColors(content, { enabled: props.streaming !== true }, findTavernQuoteRanges);
        const unbind = bindTavernFontZoom(host, doc.defaultView);
        return () => { colors.dispose(); unbind(); };
    }, [html, mode, props.streaming, props.fileMentions, prepared.slots]);
    return React.createElement('div', { ref: root, className: 'dsh-tavern-colored-markdown dsh-tavern-body-markdown' },
        mounts.filter(item => item.node !== null).map(item => ReactDOM.createPortal(item.node, item.target, item.id)),
        props.renderBusiness ? props.renderBusiness(new Map(mounts.map(item => [item.id, item.target])), root.current?.querySelector('.dsh-tavern-body-content')) : null);
}

// 只同步作者生成的节点；复用未变化容器和 React 挂载点，保留 details 展开与 DOM 选择。
const tavernBodyAttributes = new WeakMap();
function patchTavernBodyDom(target, source) {
    const businessNode = node => node?.nodeType === 1 && node.matches('.fork-stage-enter-here[data-fork-stage-source]');
    let at = target.firstChild;
    for (const wanted of [...source.childNodes]) {
        while (businessNode(at)) at = at.nextSibling;
        const same = at && at.nodeType === wanted.nodeType && (at.nodeType !== 1 || at.localName === wanted.localName && at.getAttribute('data-dsh-body-mount') === wanted.getAttribute('data-dsh-body-mount'));
        let current;
        if (same) current = at;
        else {
            const key = wanted.nodeType === 1 && wanted.getAttribute('data-dsh-body-mount');
            current = key && [...target.children].find(node => node.localName === wanted.localName && node.getAttribute('data-dsh-body-mount') === key);
            if (!current) current = wanted.cloneNode(false);
            target.insertBefore(current, at);
        }
        if (current.nodeType === 3 || current.nodeType === 8) { if (current.data !== wanted.data) current.data = wanted.data; }
        if (current.nodeType === 1) {
            const previous = tavernBodyAttributes.get(current) || new Map();
            const next = new Map([...wanted.attributes].map(attr => [attr.name, attr.value]));
            for (const name of previous.keys()) if (!next.has(name)) current.removeAttribute(name);
            for (const [name, value] of next) if (previous.get(name) !== value) current.setAttribute(name, value);
            tavernBodyAttributes.set(current, next);
            if (!wanted.hasAttribute('data-dsh-body-mount')) patchTavernBodyDom(current, wanted);
        }
        at = current.nextSibling;
    }
    while (at) { const stale = at; at = at.nextSibling; if (!businessNode(stale)) stale.remove(); }
    const entries = [...target.children].filter(businessNode);
    const tail = [...target.childNodes].slice(-entries.length);
    if (entries.length && entries.some((node, index) => tail[index] !== node)) entries.forEach(node => target.appendChild(node));
}

// 保留普通正文的排版偏好；作者 HTML 的结构与换行交给共享转换器原样解释。
function layoutTavernBodyText(text, streaming) {
    const source = String(text || '');
    const syntax = source.replace(/<span data-dsh-body-slot="[^"]+"><\/span>/g, '');
    return streaming !== true && !/<[!/?a-zA-Z]/.test(syntax) && typeof layoutTavernProseText === 'function'
        ? layoutTavernProseText(source) : source;
}
