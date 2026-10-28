function TavernWorldbookInspector(props) {
    const h = React.createElement;
    const [data, setData] = React.useState(null), [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false), [query, setQuery] = React.useState('');
    const [page, setPage] = React.useState(0), [mode, setMode] = React.useState('catalog');
    const [source, setSource] = React.useState(null);
    const generation = React.useRef(0);
    async function refresh() {
        const request = ++generation.current;
        setBusy(true); setError(''); setSource(null);
        try { const result = await rpc('inspectWorldbookSkills', { offset: page }, props.sessionId); if (request === generation.current) setData(result); }
        catch (e) { if (request === generation.current) setError(e.message || String(e)); }
        finally { if (request === generation.current) setBusy(false); }
    }
    React.useEffect(() => { refresh(); return () => { generation.current++; }; }, [page]);
    async function read(entry) {
        const request = ++generation.current;
        setBusy(true); setError(''); setSource(null);
        try { const result = await rpc('readWorldbookSkillSource', { path: entry.path, ref: entry.ref }, props.sessionId); if (request === generation.current) setSource({ title: entry.title, content: result.content }); }
        catch (e) { if (request === generation.current) setError(e.message || String(e)); }
        finally { if (request === generation.current) setBusy(false); }
    }
    const button = (label, onClick, disabled) => h('button', { className: 'dsh-tavern-btn', onClick, disabled }, label);
    const clusters = data?.catalog?.clusters || [];
    const matches = value => String(value || '').toLowerCase().includes(query.toLowerCase());
    return h('aside', { className: 'dsh-tavern-status dsh-wb-inspector', 'aria-label': '虚拟 Skill 排查' },
        h('header', null, h('strong', null, '虚拟 Skill'), button(busy ? '加载中…' : '刷新', refresh, busy)),
        h('p', { className: 'dsh-wb-muted' }, '本局世界书生成的实体 Skill。只读查看不会计入模型调用。'),
        error && h('p', { role: 'alert' }, error),
        data && h(React.Fragment, null,
            h('div', { className: 'dsh-wb-stats' }, `${clusters.length} 类 · ${clusters.reduce((n, c) => n + c.entries.length, 0)} 条原文`, h('br'), `成功加载 ${data.counts.skills} 次 · 独立读取 ${data.counts.entries} 次 · 随 Skill 载入 ${data.counts.inlineEntries || 0} 条次 · 错误 ${data.counts.errors} 次`),
            data.catalog?.directory && h('details', null, h('summary', null, '实体文件夹'), h('code', null, data.catalog.directory), h('p', { className: 'dsh-wb-muted' }, '由世界书自动同步；修改生成文件不会修改世界书。')),
            h('nav', null, button('分类与内容', () => { setMode('catalog'); setSource(null); }), button(`调用记录 (${data.total})`, () => { setMode('history'); setSource(null); })),
            h('input', { type: 'search', placeholder: '搜索分类、条目或本页调用', 'aria-label': '搜索虚拟 Skill', value: query, onChange: e => setQuery(e.target.value) }),
            source ? h('section', null, button('← 返回目录', () => setSource(null)), h('h3', null, source.title), h('pre', null, source.content)) : mode === 'catalog' ? h('section', null,
                !data.catalog && h('p', null, '当前对局未启用虚拟 Skill，或原生读取工具不可用。'),
                data.catalog && !clusters.length && h('p', null, '当前没有可用的静态 Skill 条目；预处理尚未完成或条目被排除时，目录也可能为空。'),
                h('p', { className: 'dsh-wb-muted' }, '仅收录可见、启用的静态非常驻条目；动态模板、常驻条目和 MVU 不在此目录。'),
                clusters.filter(c => matches(c.title) || matches(c.keywords.join(' ')) || c.entries.some(e => matches(e.title))).map(c => h('details', { key: c.name },
                    h('summary', null, `${c.title} · ${c.entries.length} 条 · ${c.inline ? "内联" : "参考文件"} · 约 ${c.estimatedTokens} token · 加载 ${c.readCount} 次`),
                    h('p', { className: 'dsh-wb-muted' }, c.keywords.join(' · ')),
                    h('code', null, c.name),
                    h('details', null, h('summary', null, 'SKILL.md · 主题与资料'), h('pre', null, c.guide)),
                    c.entries.map(e => h('div', { key: e.ref, className: 'dsh-wb-entry' }, button(e.title + " · 载入 " + (e.readCount + (e.inlineReadCount || 0)) + " 次", () => read(e), busy), h('small', null, `原始条目 ID ${e.uid ?? e.ref} · ${e.inline ? "内联于 SKILL.md" : "references/" + e.path.split(/[\\/]/).pop()}`)))))) : h('section', null,
                h('p', { className: 'dsh-wb-muted' }, '原生调用历史（含重试／回退前记录）。成功读取不代表正文一定采用；轮次为原生会话轮次。'),
                !data.historyLoaded && h('p', null, '会话事件尚未加载，统计暂不可用。'),
                data.records.filter(r => matches(r.target) || matches(r.title)).map(r => h('details', { key: r.id }, h('summary', null, `第 ${r.turn} 轮 · ${r.kind === 'skill' ? '加载 Skill' : r.reference ? '读取原文' : '读取目录／指南'} · ${{ success: '成功', error: '失败', pending: '等待结果' }[r.status]}`), h('p', null, r.title), h('code', null, r.target), h('p', null, `步骤 ${r.step}${r.offset ? ' · 起始行 ' + r.offset : ''}${r.totalLines !== undefined ? ' · 共 ' + r.totalLines + ' 行' : ''}`), h('pre', null, r.result || '暂无返回内容'))),
                h('nav', null, button('上一页', () => setPage(Math.max(0, page - 40)), busy || page === 0), h('small', null, `${data.total ? page + 1 : 0}–${Math.min(page + 40, data.total)} / ${data.total}`), button('下一页', () => setPage(page + 40), busy || page + 40 >= data.total)))));
}
