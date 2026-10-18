/* eslint-disable no-unused-vars -- include 片段的符号由同一 factory 内其它源码使用。 */
// 消息 iframe 的运行诊断上报器。整段以 toString() 注入 iframe，只能用 ES5 语法，
// 不能引用工厂作用域里的其他符号；需要的协作函数通过参数传入。
//
// 协议（runtime.domSnapshot）：
//   status not_collected —— 默认轻量包：load/resize/console/error/network 触发，不遍历、不克隆、不序列化 body；
//   status empty         —— 宿主显式请求，body 存在但没有任何子节点；
//   status complete      —— 宿主显式请求，预算内走完整棵树；
//   status partial       —— 宿主显式请求，命中节点/字符/属性/深度/兄弟预算，reasons 给出原因。
//   documentToken        —— 采集所属 iframe 文档的 token；capturedAt 只在显式采集时写入，表示 DOM 的采集时间。
// 显式请求消息 dsh-tavern-frame-snapshot-request 只接受 event.source === parent 且 token 一致的来源。
var TAVERN_FRAME_SNAPSHOT_LIMITS = Object.freeze({
  maxNodes: 2000,
  maxChars: 60000,
  maxTextChars: 2000,
  maxAttributes: 16,
  maxAttributeChars: 256,
  maxChildren: 200,
  maxDepth: 64,
});
var TAVERN_FRAME_SNAPSHOT_CEILING = Object.freeze({
  maxNodes: 5000,
  maxChars: 100000,
  maxTextChars: 8000,
  maxAttributes: 32,
  maxAttributeChars: 2000,
  maxChildren: 1000,
  maxDepth: 128,
});
// 宿主注入 iframe 的内部脚本标记；采集时按固定列表做常数成本的 hasAttribute 判断，卡片自己的 script 保留。
var TAVERN_FRAME_INTERNAL_SCRIPT_MARKERS = Object.freeze([
  "data-dsh-tavern-frame",
  "data-dsh-tavern-frame-ready",
  "data-dsh-tavern-storage",
  "data-dsh-tavern-layout",
  "data-dsh-tavern-text-colors",
  "data-dsh-tavern-touch",
  "data-dsh-tavern-sizing",
  "data-dsh-tavern-helper",
  "data-dsh-tavern-interactive-helper",
  "data-dsh-tavern-mvu-view-observer",
  "data-dsh-tavern-crypto",
  "data-dsh-tavern-tilt-guard",
  "data-dsh-tavern-remote-document",
  "data-dsh-tavern-legacy-composer",
  "data-dsh-tavern-frame-variable-aliases",
  "data-dsh-tavern-status-refresh",
  "data-dsh-tavern-session-opening",
  "data-dsh-tavern-opening-preview",
  "data-dsh-tavern-opening-host",
  "data-dsh-tavern-status-host",
  "data-dsh-tavern-helper-dependency",
  "data-dsh-tavern-static-cache",
  "data-dsh-tavern-host-artifacts",
  "data-dsh-preserve-lines",
]);

// 宿主与 iframe 共用：把外部传入的预算压到 [1, 上限]，未知字段丢弃。
function normalizeTavernFrameSnapshotBudget(input, defaults, ceiling) {
  var out = {};
  Object.keys(defaults).forEach(function (key) {
    var value = input && typeof input === "object" ? Number(input[key]) : NaN;
    if (!isFinite(value) || value < 1) value = defaults[key];
    out[key] = Math.min(ceiling[key], Math.max(1, Math.floor(value)));
  });
  return out;
}

// 受预算限制的迭代式 DOM 采集：先判预算再取子节点，visited.nodes 严格不超过 maxNodes。
// 不 clone、不读 innerHTML/outerHTML；文本用 substringData 按预算截取，属性值截断后再转义。
// 输出是转义后的 HTML 风格文本：文本与属性里的 < > & " 都被转义，不会再构成标签。
function collectTavernFrameDomSnapshot(root, budget, options) {
  var limits = budget || {};
  var markers =
    options && Array.isArray(options.internalScriptMarkers)
      ? options.internalScriptMarkers
      : [];
  var out = [],
    chars = 0;
  var visited = { nodes: 0, chars: 0, attributes: 0, maxDepth: 0 };
  var emitted = { nodes: 0, text: 0, attributes: 0 };
  var skipped = {
    nodes: 0,
    children: 0,
    text: 0,
    attributes: 0,
    attributeChars: 0,
    depth: 0,
    internalScripts: 0,
  };
  var reasons = [];
  function reason(name) {
    if (reasons.indexOf(name) < 0) reasons.push(name);
  }
  function escapeText(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function escapeAttribute(value) {
    return escapeText(value).replace(/"/g, "&quot;");
  }
  function write(text) {
    if (chars + text.length > limits.maxChars) {
      var room = Math.max(0, limits.maxChars - chars);
      if (room > 0) {
        out.push(text.slice(0, room));
        chars += room;
      }
      reason("chars");
      return false;
    }
    out.push(text);
    chars += text.length;
    return true;
  }
  function internalScript(node) {
    if (
      !markers.length ||
      String(node.nodeName || "").toLowerCase() !== "script" ||
      typeof node.hasAttribute !== "function"
    )
      return false;
    for (var i = 0; i < markers.length; i += 1)
      if (node.hasAttribute(markers[i])) return true;
    return false;
  }
  function textOf(node) {
    var length = Number(node.length) || 0;
    visited.chars += Math.min(length, limits.maxTextChars);
    var text =
      typeof node.substringData === "function"
        ? node.substringData(0, Math.min(length, limits.maxTextChars))
        : String(node.nodeValue || "").slice(0, limits.maxTextChars);
    if (length > limits.maxTextChars) {
      skipped.text += length - limits.maxTextChars;
      reason("text");
      text += "…";
    }
    return text;
  }
  function openTag(node) {
    var tag = String(node.nodeName || "").toLowerCase();
    var attributes = node.attributes || [];
    var parts = ["<" + tag];
    var count = Math.min(attributes.length, limits.maxAttributes);
    for (var i = 0; i < count; i += 1) {
      var name = String(attributes[i].name || "");
      var raw = String(attributes[i].value == null ? "" : attributes[i].value);
      visited.attributes += 1;
      var value =
        raw.length > limits.maxAttributeChars
          ? raw.slice(0, limits.maxAttributeChars) + "…"
          : raw;
      if (raw.length > limits.maxAttributeChars) {
        skipped.attributeChars += raw.length - limits.maxAttributeChars;
        reason("attribute-chars");
      }
      emitted.attributes += 1;
      parts.push(" " + name + '="' + escapeAttribute(value) + '"');
    }
    if (attributes.length > count) {
      skipped.attributes += attributes.length - count;
      reason("attributes");
      parts.push(
        ' data-dsh-snapshot-omitted-attributes="' +
          (attributes.length - count) +
          '"',
      );
    }
    return parts.join("") + ">";
  }
  var stopped = false;
  if (!root) return finish("empty");
  var children = root.childNodes || [];
  if (!children.length) return finish("empty");
  // 显式栈代替递归：深树不会爆栈；每层记录下一个子索引和已发出的子节点数。
  var stack = [{ node: root, index: 0, emitted: 0, depth: 0, close: "" }];
  while (stack.length && !stopped) {
    var frame = stack[stack.length - 1];
    var list = frame.node.childNodes || [];
    if (frame.index >= list.length) {
      stack.pop();
      if (frame.close && !write(frame.close)) stopped = true;
      continue;
    }
    if (frame.emitted >= limits.maxChildren) {
      var omitted = list.length - frame.index;
      skipped.children += omitted;
      frame.index = list.length;
      reason("children");
      if (!write("<!-- 省略 " + omitted + " 个兄弟节点 -->")) stopped = true;
      continue;
    }
    // 节点预算先于任何子节点访问。
    if (visited.nodes >= limits.maxNodes) {
      skipped.nodes += list.length - frame.index;
      reason("nodes");
      stopped = true;
      continue;
    }
    var child = list[frame.index];
    frame.index += 1;
    visited.nodes += 1;
    var depth = frame.depth + 1;
    if (depth > visited.maxDepth) visited.maxDepth = depth;
    var type = child.nodeType;
    if (type === 3) {
      frame.emitted += 1;
      emitted.nodes += 1;
      emitted.text += 1;
      if (!write(escapeText(textOf(child)))) stopped = true;
    } else if (type === 8) {
      frame.emitted += 1;
      emitted.nodes += 1;
      if (!write("<!--" + escapeText(textOf(child)) + "-->")) stopped = true;
    } else if (type === 1) {
      if (internalScript(child)) {
        skipped.internalScripts += 1;
        continue;
      }
      frame.emitted += 1;
      emitted.nodes += 1;
      if (!write(openTag(child))) {
        stopped = true;
        continue;
      }
      var tag = String(child.nodeName || "").toLowerCase();
      if (depth >= limits.maxDepth) {
        if ((child.childNodes || []).length) {
          skipped.depth += 1;
          reason("depth");
          write("<!-- 深度已截断 -->");
        }
        if (!write("</" + tag + ">")) stopped = true;
      } else
        stack.push({
          node: child,
          index: 0,
          emitted: 0,
          depth: depth,
          close: "</" + tag + ">",
        });
    }
  }
  return finish(reasons.length ? "partial" : "complete");
  function finish(status) {
    return {
      status: status,
      html: out.join(""),
      reasons: reasons.slice(),
      limits: limits,
      visited: {
        nodes: visited.nodes,
        chars: visited.chars,
        attributes: visited.attributes,
        maxDepth: visited.maxDepth,
      },
      emitted: {
        nodes: emitted.nodes,
        text: emitted.text,
        attributes: emitted.attributes,
        chars: chars,
      },
      skipped: skipped,
    };
  }
}

// iframe 内安装：console/error/unhandledrejection/fetch/XHR 轻量记录，load/resize 触发汇报；
// 默认包永不碰 body。显式快照只响应父窗口带正确 token 的请求。
function installTavernFrameRuntimeReporter(
  token,
  options,
  collectDomSnapshot,
  normalizeBudget,
) {
  var config = options || {};
  var snapshotAllowed = config.allowSnapshot !== false;
  var limits = config.limits || {},
    ceiling = config.ceiling || limits,
    markers = config.internalScriptMarkers || [];
  var logs = [],
    network = [],
    errors = [],
    timer = 0,
    counters = { reports: 0, snapshots: 0 };
  function trim(list) {
    if (list.length > 100) list.splice(0, list.length - 100);
  }
  function value(input, depth) {
    if (depth > 3) return "[深度已截断]";
    if (
      input === null ||
      input === undefined ||
      typeof input === "boolean" ||
      typeof input === "number" ||
      typeof input === "string"
    )
      return typeof input === "string" && input.length > 4000
        ? input.slice(0, 4000) + "…[已截断]"
        : input;
    try {
      if (
        input instanceof Error ||
        Object.prototype.toString.call(input) === "[object Error]"
      )
        return {
          name: String(input.name),
          message: String(input.message).slice(0, 4000),
          stack: String(input.stack || "").slice(0, 4000),
        };
      if (Array.isArray(input))
        return input.slice(0, 30).map(function (item) {
          return value(item, depth + 1);
        });
      if (typeof input === "object") {
        var out = {};
        Object.keys(input)
          .slice(0, 30)
          .forEach(function (key) {
            out[key] = value(input[key], depth + 1);
          });
        return out;
      }
    } catch (e) {}
    return String(input);
  }
  function cleanUrl(input) {
    try {
      var parsed = new URL(String(input), location.href);
      return parsed.protocol + "//" + parsed.host + parsed.pathname;
    } catch (e) {
      return String(input || "")
        .split(/[?#]/)[0]
        .slice(0, 1000);
    }
  }
  function layout() {
    try {
      return window.__dshTavernFrameLayout
        ? window.__dshTavernFrameLayout()
        : null;
    } catch (e) {
      return null;
    }
  }
  function post(dom, snapshot, requestId) {
    snapshot.documentToken = token;
    snapshot.reports = counters.reports;
    snapshot.snapshots = counters.snapshots;
    var runtime = {
      capturedAt: Date.now(),
      layout: layout(),
      dom: dom,
      domSnapshot: snapshot,
      console: logs.slice(),
      network: network.slice(),
      errors: errors.slice(),
    };
    var message = {
      type: "dsh-tavern-frame-runtime",
      token: token,
      runtime: runtime,
    };
    if (requestId) message.requestId = requestId;
    parent.postMessage(message, "*");
  }
  function send() {
    timer = 0;
    counters.reports += 1;
    post("", { status: "not_collected" });
  }
  function schedule() {
    if (timer) return;
    timer = setTimeout(send, 350);
  }
  function snapshot(request) {
    var requestId = String(request.requestId || "");
    var budget = normalizeBudget(request.budget, limits, ceiling);
    if (!snapshotAllowed) {
      post("", { status: "not_collected", reason: "disabled" }, requestId);
      return;
    }
    var collected;
    try {
      collected = collectDomSnapshot(document.body, budget, {
        internalScriptMarkers: markers,
      });
    } catch (e) {
      post(
        "",
        {
          status: "not_collected",
          reason: "error",
          error: String((e && e.message) || e).slice(0, 500),
        },
        requestId,
      );
      return;
    }
    counters.snapshots += 1;
    post(
      collected.html,
      {
        status: collected.status,
        capturedAt: Date.now(),
        reasons: collected.reasons,
        limits: collected.limits,
        visited: collected.visited,
        emitted: collected.emitted,
        skipped: collected.skipped,
      },
      requestId,
    );
  }
  ["log", "info", "warn", "error"].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      logs.push({
        at: Date.now(),
        level: level,
        args: Array.prototype.map.call(arguments, function (item) {
          return value(item, 0);
        }),
      });
      trim(logs);
      schedule();
      return original && original.apply(console, arguments);
    };
  });
  addEventListener(
    "error",
    function (event) {
      var target = event.target;
      if (target && target !== window)
        errors.push({
          at: Date.now(),
          kind: "resource",
          tag: String(target.tagName || ""),
          url: cleanUrl(target.src || target.href || ""),
        });
      else
        errors.push({
          at: Date.now(),
          kind: "error",
          message: String(event.message || ""),
          source: cleanUrl(event.filename || ""),
          line: Number(event.lineno) || 0,
          column: Number(event.colno) || 0,
        });
      trim(errors);
      schedule();
    },
    true,
  );
  addEventListener("unhandledrejection", function (event) {
    errors.push({
      at: Date.now(),
      kind: "unhandledrejection",
      message: String(
        (event.reason && event.reason.message) || event.reason || "",
      ),
    });
    trim(errors);
    schedule();
  });
  if (typeof window.fetch === "function") {
    var nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      var started = Date.now(),
        method = String((init && init.method) || "GET").toUpperCase(),
        url = cleanUrl((input && input.url) || input);
      return nativeFetch.apply(this, arguments).then(
        function (response) {
          network.push({
            at: started,
            kind: "fetch",
            method: method,
            url: url,
            status: Number(response.status) || 0,
            durationMs: Date.now() - started,
          });
          trim(network);
          if (!response.ok) schedule();
          return response;
        },
        function (error) {
          network.push({
            at: started,
            kind: "fetch",
            method: method,
            url: url,
            failed: true,
            durationMs: Date.now() - started,
            error: String((error && error.message) || error),
          });
          trim(network);
          schedule();
          throw error;
        },
      );
    };
  }
  if (typeof XMLHttpRequest === "function") {
    var nativeOpen = XMLHttpRequest.prototype.open,
      nativeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__dshRequest = {
        started: 0,
        method: String(method || "GET").toUpperCase(),
        url: cleanUrl(url),
      };
      return nativeOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var request = this.__dshRequest || { method: "GET", url: "" };
      request.started = Date.now();
      this.addEventListener("loadend", function () {
        network.push({
          at: request.started,
          kind: "xhr",
          method: request.method,
          url: request.url,
          status: Number(this.status) || 0,
          durationMs: Date.now() - request.started,
        });
        trim(network);
        if (Number(this.status) >= 400) schedule();
      });
      return nativeSend.apply(this, arguments);
    };
  }
  addEventListener("message", function (event) {
    var data = event && event.data;
    if (
      !data ||
      event.source !== parent ||
      data.token !== token ||
      data.type !== "dsh-tavern-frame-snapshot-request"
    )
      return;
    snapshot(data);
  });
  addEventListener("load", schedule);
  addEventListener("resize", schedule);
  schedule();
}

// 宿主侧：1 秒合并窗口内，后到的轻量包不得覆盖同一文档先到的显式快照；换文档后不继承。
function tavernFrameRuntimeSnapshotCollected(runtime) {
  var status = runtime && runtime.domSnapshot && runtime.domSnapshot.status;
  return status === "complete" || status === "partial" || status === "empty";
}
function mergeTavernFrameRuntimeReports(previous, next) {
  if (
    !previous ||
    !next ||
    tavernFrameRuntimeSnapshotCollected(next) ||
    !tavernFrameRuntimeSnapshotCollected(previous)
  )
    return next;
  var previousToken =
      previous.domSnapshot && previous.domSnapshot.documentToken,
    nextToken = next.domSnapshot && next.domSnapshot.documentToken;
  if (!previousToken || previousToken !== nextToken) return next;
  return Object.assign({}, next, {
    dom: previous.dom,
    domSnapshot: previous.domSnapshot,
  });
}

// 宿主侧：只放行白名单里的数值/枚举，DOM 正文、日志参数一律不进诊断环。
function tavernFrameRuntimeMetrics(runtime, requested) {
  var snapshot =
    runtime && runtime.domSnapshot && typeof runtime.domSnapshot === "object"
      ? runtime.domSnapshot
      : {};
  var status =
    ["not_collected", "empty", "complete", "partial"].indexOf(
      snapshot.status,
    ) >= 0
      ? snapshot.status
      : "not_collected";
  function count(value) {
    var number = Number(value);
    return isFinite(number) && number > 0 ? Math.floor(number) : 0;
  }
  return {
    kind: requested ? "snapshot" : "report",
    status: status,
    visitedNodes: count(snapshot.visited && snapshot.visited.nodes),
    visitedChars: count(snapshot.visited && snapshot.visited.chars),
    emittedChars: count(snapshot.emitted && snapshot.emitted.chars),
    truncated: status === "partial",
    consoleEntries: count(
      runtime && Array.isArray(runtime.console) && runtime.console.length,
    ),
    errorEntries: count(
      runtime && Array.isArray(runtime.errors) && runtime.errors.length,
    ),
  };
}

// 活跃消息 iframe 生命周期的注册表：公开诊断入口只在这里找当前页面真实挂着的 frame，
// 不遍历历史存档；同一时刻只允许一次显式采集。
function createTavernFrameRuntimeRegistry() {
  var entries = new Set();
  var busy = false;
  function match(entry, query) {
    var state = entry.describe();
    if (!state || !state.sessionId || state.sessionId !== query.gameId)
      return false;
    if (query.turn !== undefined && Number(state.turn) !== Number(query.turn))
      return false;
    if (
      query.partIndex !== undefined &&
      Number(state.partIndex) !== Number(query.partIndex)
    )
      return false;
    if (
      query.panelId !== undefined &&
      String(state.panelId || "") !== String(query.panelId)
    )
      return false;
    return true;
  }
  return {
    register: function (entry) {
      entries.add(entry);
      return function () {
        entries.delete(entry);
      };
    },
    size: function () {
      return entries.size;
    },
    // 未指定轮次时取当前挂载里最新一轮；同轮多个 part 取 partIndex 最小者，除非指定。
    find: function (query) {
      var best = null,
        bestState = null;
      entries.forEach(function (entry) {
        if (!match(entry, query)) return;
        var state = entry.describe();
        if (!state) return;
        if (
          !best ||
          Number(state.turn) > Number(bestState.turn) ||
          (Number(state.turn) === Number(bestState.turn) &&
            Number(state.partIndex) < Number(bestState.partIndex))
        ) {
          best = entry;
          bestState = state;
        }
      });
      return best;
    },
    capture: function (query, budget) {
      if (busy)
        return Promise.reject(new Error("已有一次 DOM 采集进行中，请稍后再试"));
      var entry = this.find(query);
      if (!entry)
        return Promise.reject(
          new Error("这一局当前页面没有挂着符合条件的消息 iframe"),
        );
      var state = entry.describe();
      if (!state)
        return Promise.reject(
          new Error("这一局当前页面没有挂着符合条件的消息 iframe"),
        );
      busy = true;
      return Promise.resolve()
        .then(function () {
          return entry.requestRuntimeSnapshot(budget);
        })
        .then(
          function (runtime) {
            busy = false;
            var snapshot =
              runtime &&
              runtime.domSnapshot &&
              typeof runtime.domSnapshot === "object"
                ? runtime.domSnapshot
                : { status: "not_collected" };
            return {
              gameId: state.sessionId,
              turn: state.turn,
              partIndex: state.partIndex,
              panelId: state.panelId || "",
              status: snapshot.status,
              dom: typeof runtime.dom === "string" ? runtime.dom : "",
              domSnapshot: snapshot,
            };
          },
          function (error) {
            busy = false;
            throw error;
          },
        );
    },
  };
}
const tavernFrameRuntimeRegistry = createTavernFrameRuntimeRegistry();
