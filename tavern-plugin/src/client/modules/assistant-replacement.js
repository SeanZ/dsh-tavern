// rc.2 的当前事件窗口保留 replace 正文，但原生助手 matcher 只接收 append。
// 仅补齐 Chat 的助手匹配与旧正文可见性；原始事件、来源和其它视图保持原样。
function installTavernAssistantReplacementPatch(conversation) {
    const registry = conversation?.ConversationEventRegistry?.prototype;
    const assembler = conversation?.ConversationNodeAssembler?.prototype;
    if (!registry || !assembler || typeof registry.forEvent !== "function"
        || typeof assembler.sortedInputs !== "function" || typeof assembler.buildNode !== "function"
        || assembler.__dshTavernAssistantReplacement) return;
    const replacement = event => event?.type === "assistant/message" && event.surfaceOp?.op === "replace";
    const forEvent = registry.forEvent;
    const routes = new WeakMap();
    registry.forEvent = function (type) {
        const source = forEvent.call(this, type);
        if (type !== "assistant/message" || !source) return source;
        if (!routes.has(source)) routes.set(source, new Set(Array.from(source, route => {
            if (route.definition.kind !== "assistant-step") return route;
            return { ...route, match(event) {
                const result = route.match(event);
                return result === null && replacement(event)
                    ? route.match({ ...event, surfaceOp: "append" }) : result;
            } };
        })));
        return routes.get(source);
    };
    const ranges = new WeakMap();
    function replaced(owner, seq) {
        if (!Number.isFinite(seq)) return false;
        let intervals = ranges.get(owner);
        if (!intervals) {
            const raw = Array.from(owner.inputs.values(), entry => entry.event).filter(replacement)
                .map(event => [event.surfaceOp.startSeq, event.surfaceOp.endSeq])
                .filter(([start, end]) => Number.isSafeInteger(start) && end >= start)
                .sort((a, b) => a[0] - b[0]);
            intervals = [];
            for (const range of raw) {
                const last = intervals.at(-1);
                if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
                else intervals.push(range);
            }
            ranges.set(owner, intervals);
        }
        let lo = 0, hi = intervals.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (intervals[mid][0] <= seq) lo = mid + 1;
            else hi = mid;
        }
        return lo > 0 && seq <= intervals[lo - 1][1];
    }
    const buildNode = assembler.buildNode;
    assembler.buildNode = function (context, target) {
        const node = buildNode.call(this, context, target);
        return target === "chat" && context.kind === "assistant-step"
            && replaced(this, node?.data?.finalNode?.seq)
            ? { ...node, visibility: "hidden" } : node;
    };
    const replaceWindow = assembler.replaceWindow;
    assembler.replaceWindow = function (...args) {
        ranges.delete(this);
        return replaceWindow.apply(this, args);
    };
    // 替换会改变既有楼层的可见性，需要让所有受影响节点一起重新投影。
    for (const method of ["append", "prepend"]) {
        const original = assembler[method];
        assembler[method] = function (input, ...args) {
            const changed = method === "append" ? replacement(input.event) : input.some(entry => replacement(entry.event));
            if (changed) ranges.delete(this);
            const publication = original.call(this, input, ...args);
            return changed ? this.replaceWindow(this.sortedInputs(), this.hasMore) : publication;
        };
    }
    Object.defineProperty(assembler, "__dshTavernAssistantReplacement", { value: true });
}
