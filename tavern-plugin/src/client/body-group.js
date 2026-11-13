// 语法组只负责一次转换；气泡和配音继续使用各旧 Markdown part 的全文、scope 和段落基数。
function prepareTavernBodyGroup(group, sourceParts, options) {
    let prefix = 'dsh-body-slot-';
    while (group.text.includes(prefix)) prefix += 'x-';
    const edits = [], sources = [];
    for (const member of group.members) {
        const part = sourceParts[member.sourcePartIndex];
        if (!part || part.kind !== 'markdown' || member.frameIndex === null) continue;
        const text = String(part.text || '');
        const literal = bubbleLiteralLines(text);
        const segments = parseBubbles(text, options.streaming === true);
        const bubbleIndices = segments.flatMap((segment, index) => segment.kind === 'bubble' ? [index] : []);
        let offset = 0, bubble = 0;
        const targets = {};
        for (const [index, line] of text.split('\n').entries()) {
            if (literal.has(index)) { offset += line.length + 1; continue; }
            const parsed = parseBubbles(line, options.streaming === true && offset + line.length === text.length, { singleLine: true });
            if (parsed.some(segment => segment.kind === 'bubble')) {
                const id = prefix + 'b' + member.sourcePartIndex + '-' + index;
                targets[bubbleIndices[bubble++]] = id;
                edits.push({ start: member.start + offset, end: member.start + offset + line.length, id, block: true, isolated: true, node: options.static ? React.createElement(TavernStaticBodyBubble, { segment: parsed.find(segment => segment.kind === 'bubble'), sessionId: options.sessionId }) : null });
            } else if (/^\s*[`*_~]*@/.test(line) && parsed.map(segment => segment.text || '').join('\n') !== line) {
                edits.push({ start: member.start + offset, end: member.start + offset + line.length, text: parsed.map(segment => segment.text || '').join('\n') });
            }
            offset += line.length + 1;
        }
        sources.push({ member, text, targets, base: sourceParts.slice(0, member.sourcePartIndex).reduce((n, part) => n + (part.kind === 'markdown' ? galParagraphCount(part.text) : 0), 0) });
    }
    if (options.plugin?.prepareBody) {
        const bodyEdits = edits.slice();
        for (const segment of options.plugin.prepareBody(group.text)) {
            if (segment.node === undefined) continue;
            // 业务行不可被外部标记切碎；跨边界匹配保留原文，组件落在完整业务行之后。
            // 零宽媒体锚点同样避开退化气泡的文本替换范围。
            const overlaps = bodyEdits.filter(edit => segment.start < edit.end && (segment.end > edit.start || segment.start >= edit.start));
            const start = overlaps.length ? Math.max(...overlaps.map(edit => edit.end)) : segment.start;
            edits.push({ ...segment, start, end: overlaps.length ? start : segment.end, dynamic: true, isolated: overlaps.length > 0 && segment.block === true, id: prefix + 'm' + edits.length });
        }
    }
    edits.sort((a, b) => a.start - b.start || a.end - b.end);
    let cursor = 0, text = '';
    const slots = [];
    for (const edit of edits) {
        if (edit.start < cursor) continue;
        text += group.text.slice(cursor, edit.start);
        if (edit.id) { const marker = '<span data-dsh-body-slot="' + edit.id + '"></span>'; text += edit.isolated ? "\n\n" + marker + "\n\n" : marker; slots.push(edit); }
        else text += edit.text;
        cursor = edit.end;
    }
    text += group.text.slice(cursor);
    return { text, slots, sources };
}
function TavernBodyGroup(props) {
    const prepared = props.prepared;
    function business(mounts, root) {
        if (props.static || !root) return null;
        return prepared.sources.map(source => React.createElement(bubblePublicationType(), {
            key: source.member.frameIndex, sessionId: props.sessionId, text: source.text,
            voiceScope: String(props.turn) + ':' + source.member.frameIndex, stageParaBase: source.base,
            stageSource: props.forkStageSource, voiceAuto: props.voiceAuto, interrupted: props.interrupted,
            streaming: props.streaming, bodyRoot: root, bodyTargets: source.targets, bodyMounts: mounts,
            labels: props.labels, codeLabels: props.codeLabels
        }));
    }
    return React.createElement(TavernBodyMarkdown, { ...props, prepared, renderBusiness: business });
}

function TavernStaticBodyBubble(props) {
    const select = React.useMemo(() => bubbleMessageSelector([props.segment]), [props.segment]);
    const data = useBubbles(props.sessionId, true, select);
    return React.createElement(BubbleRow, { ...props, config: data?.config || null });
}
