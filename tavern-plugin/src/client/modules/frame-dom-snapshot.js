// 显式快照只访问预算内的节点，再序列化选中的小树。节点、深度及 UTF-8 字节都有硬上限；
// 不整树 clone，不读取 innerHTML，也不先展开全部兄弟节点或转义超长文本。
// eslint-disable-next-line no-unused-vars -- 由客户端拼接入口及 frame 脚本调用。
function captureTavernBoundedDom(root, budget) {
    function limit(name, fallback) {
        var value = Number(budget && budget[name]);
        return Number.isFinite(value) && value > 0 ? Math.min(fallback, Math.floor(value)) : fallback;
    }
    var limits = { nodes: limit("nodes", 2000), depth: limit("depth", 32), bytes: limit("bytes", 100000) };
    var nodes = 0,
        visited = 0,
        bytes = 0,
        deepest = 0,
        truncated = false;
    var voids = /^(?:area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/;
    function escaped(value, available, attribute) {
        var out = "",
            used = 0,
            index = 0;
        for (; index < value.length; index += part.length) {
            var code = value.codePointAt(index),
                part = String.fromCodePoint(code);
            var replacement =
                part === "&"
                    ? "&amp;"
                    : part === "<"
                      ? "&lt;"
                      : part === ">"
                        ? "&gt;"
                        : attribute && part === '"'
                          ? "&quot;"
                          : part;
            var cost =
                replacement === part ? (code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4) : replacement.length;
            if (used + cost > available) break;
            out += replacement;
            used += cost;
        }
        return { text: out, bytes: used, complete: index === value.length };
    }
    function own(node) {
        if (!/^(?:script|style)$/i.test(node.tagName)) return false;
        // 属性遍历也受字节预算约束，避免巨大属性集合绕过工作量限制。
        for (var i = 0; i < Math.min(node.attributes.length, limits.bytes); i++) {
            if (node.attributes[i].name.indexOf("data-dsh-tavern") === 0) return true;
        }
        return false;
    }
    function tagParts(node, available) {
        var name = node.tagName.toLowerCase(),
            close = voids.test(name) ? "" : "</" + name + ">";
        var head = "<" + name;
        var boundedName = escaped(name, available, false);
        if (!boundedName.complete) return null;
        var cost = 2 + boundedName.bytes + (close ? 3 + boundedName.bytes : 0);
        if (cost > available) return null;
        for (var i = 0; i < node.attributes.length; i++) {
            var attr = node.attributes[i],
                prefix = " " + attr.name + '="';
            var boundedAttribute = escaped(attr.name, available - cost, false);
            if (!boundedAttribute.complete) return null;
            cost += boundedAttribute.bytes + 4;
            if (cost > available) return null;
            var value = escaped(attr.value, available - cost, true);
            if (!value.complete) return null;
            head += prefix + value.text + '"';
            cost += value.bytes;
        }
        return { head: head + ">", close: close, bytes: cost };
    }
    var kept = { children: [] };
    var stack = [{ next: root.firstChild, depth: 1, parent: kept }];
    while (stack.length) {
        var frame = stack[stack.length - 1],
            node = frame.next;
        if (!node) {
            stack.pop();
            continue;
        }
        if (visited >= limits.nodes || bytes >= limits.bytes) {
            truncated = true;
            break;
        }
        visited++;
        frame.next = node.nextSibling;
        if (node.nodeType !== 1 && node.nodeType !== 3) continue;
        if (frame.depth > limits.depth) {
            truncated = true;
            continue;
        }
        if (node.nodeType === 1 && own(node)) continue;
        var entry;
        if (node.nodeType === 3) {
            var text = escaped(node.data, limits.bytes - bytes, false);
            entry = { text: text.text };
            bytes += text.bytes;
            if (!text.complete) truncated = true;
        } else {
            var tag = tagParts(node, limits.bytes - bytes);
            if (!tag) {
                truncated = true;
                break;
            }
            entry = { head: tag.head, close: tag.close, children: [] };
            bytes += tag.bytes;
        }
        frame.parent.children.push(entry);
        nodes++;
        deepest = Math.max(deepest, frame.depth);
        if (node.nodeType === 1 && entry.close)
            stack.push({ next: node.firstChild, depth: frame.depth + 1, parent: entry });
        if (node.nodeType === 3 && !text.complete) break;
    }
    function serialize(entry) {
        return entry.text !== undefined
            ? entry.text
            : entry.head + entry.children.map(serialize).join("") + entry.close;
    }
    var dom = kept.children.map(serialize).join("");
    var marker = "<!-- 已截断 -->",
        markerBytes = 18;
    if (truncated && bytes + markerBytes <= limits.bytes) {
        dom += marker;
        bytes += markerBytes;
    }
    return { dom: dom, truncated: truncated, nodes: nodes, visited: visited, depth: deepest, bytes: bytes };
}
