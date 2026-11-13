// A synchronous DSH display adapter: current message identity + local regexes
// + the same pinned Markdown parser used by the host. Refresh affects DOM only.
function installTavernHelperDisplayApi(window, createBodyMarkdown) {
    // 显示依赖只在格式化时初始化；资源加载失败不能中断变量和事件 API 的安装。
    let renderBodyMarkdown;
    function messageId(value = 'last') {
        const last = window.getLastMessageId();
        if (last < 0) throw new Error('未找到任何消息楼层');
        if (value === 'last') return last;
        if (value === 'last_user' || value === 'last_char') {
            const role = value === 'last_user' ? 'user' : 'assistant';
            for (let id = last; id >= 0; id--) if (window.getChatMessages(id)[0]?.role === role) return id;
            throw new Error('未找到对应角色的消息楼层: ' + value);
        }
        if (!Number.isSafeInteger(value)) throw new Error('无效的消息楼层: ' + value);
        const id = value < 0 ? last + 1 + value : value;
        if (id < 0 || id > last) throw new Error('消息楼层不存在: ' + value);
        return id;
    }
    window.formatAsDisplayedMessage = function (text, options = {}) {
        const id = messageId(options.message_id), row = window.getChatMessages(id)[0];
        const source = row?.role === 'user' ? 'user_input' : 'ai_output';
        const input = String(text ?? '').replace(/{{\s*lastMessageId\s*}}/gi, String(window.getLastMessageId()))
            .replace(/{{\s*messageId\s*}}/gi, String(id));
        const formatted = typeof window.formatAsTavernRegexedString === 'function'
            ? window.formatAsTavernRegexedString(input, source, 'display', { depth: window.getLastMessageId() - id })
            : typeof window.substitudeMacros === 'function' ? window.substitudeMacros(input) : input;
        if (!renderBodyMarkdown) {
            if (typeof createBodyMarkdown !== 'function' || !window.showdown) throw new Error('正文显示组件尚未加载');
            renderBodyMarkdown = createBodyMarkdown(window.showdown);
        }
        return renderBodyMarkdown(formatted);
    };
    window.refreshOneMessage = async function (value, elements) {
        const selected = elements === undefined ? window.retrieveDisplayedMessage(value) : elements;
        const targets = Array.from(selected || []).filter(node => node && node.nodeType === 1);
        if (!targets.length) return;
        const id = messageId(value), row = window.getChatMessages(id)[0];
        const html = window.formatAsDisplayedMessage(row.message, {message_id: id});
        for (const element of targets) {
            const content = element.matches?.('.mes') ? element.querySelector('.mes_text') : element;
            if (!content) continue;
            // Native innerHTML intentionally does not replay embedded scripts or
            // duplicate shared card event handlers. Saved message state is untouched.
            content.innerHTML = html;
        }
        const name = row.role === 'user' ? 'USER_MESSAGE_RENDERED' : 'CHARACTER_MESSAGE_RENDERED';
        const emit = window.eventEmitAndWait || window.eventEmit;
        if (typeof emit === 'function') await emit(window.tavern_events?.[name] || name, id);
    };
    const helper = window.TavernHelper || (window.TavernHelper = {});
    for (const name of ['formatAsDisplayedMessage', 'refreshOneMessage']) Object.defineProperty(helper, name, {
        enumerable: true, configurable: true, get: () => window[name], set: value => { window[name] = value; }
    });
}
