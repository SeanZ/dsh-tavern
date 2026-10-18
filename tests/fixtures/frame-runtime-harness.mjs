// 诊断用例共用的真实客户端工厂与可控宿主通道。
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const source = await readFile(
  new URL("../../tavern-plugin/lib/client.js", import.meta.url),
  "utf8",
);

const copy = (value) => JSON.parse(JSON.stringify(value));

const tick = () => new Promise((resolve) => setImmediate(resolve));

const DEFAULTS = {
  maxNodes: 2000,
  maxChars: 60000,
  maxTextChars: 2000,
  maxAttributes: 16,
  maxAttributeChars: 256,
  maxChildren: 200,
  maxDepth: 64,
};

const CEILING = {
  maxNodes: 5000,
  maxChars: 100000,
  maxTextChars: 8000,
  maxAttributes: 32,
  maxAttributeChars: 2000,
  maxChildren: 1000,
  maxDepth: 128,
};

const MARKERS = [
  "data-dsh-tavern-frame",
  "data-dsh-tavern-touch",
  "data-dsh-tavern-layout",
  "data-dsh-tavern-host-artifacts",
];

function host(globals = {}) {
  const timers = new Map(),
    listeners = new Set(),
    saved = new Map();
  let id = 0,
    descriptor;
  const window = {
    crypto: { randomUUID: () => "token-" + ++id },
    sessionStorage: {
      getItem: (key) => saved.get(key),
      setItem: (key, value) => saved.set(key, value),
    },
    setTimeout(run, delay) {
      timers.set(++id, { run, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    addEventListener(type, run) {
      if (type === "message") listeners.add(run);
    },
    removeEventListener(type, run) {
      if (type === "message") listeners.delete(run);
    },
    __ModuleLoader__: {
      load(value) {
        descriptor = value;
      },
    },
  };
  vm.runInNewContext(source, { window, console: { warn() {} }, ...globals });
  const client = descriptor.factory(() => ({}));
  return {
    window,
    client,
    timers,
    listeners,
    runTimer(filter = () => true) {
      for (const [key, timer] of timers) {
        if (!filter(timer)) continue;
        timers.delete(key);
        return timer.run();
      }
      throw new Error("没有可运行的计时器");
    },
    deliver(node, data, sender = node.contentWindow) {
      for (const run of listeners) run({ source: sender, data });
    },
  };
}

const { client } = host();

function spyWholeTreeAccess(dom) {
  const counts = { cloneNode: 0, innerHTML: 0, outerHTML: 0 };
  const { Node, Element } = dom.window;
  const clone = Node.prototype.cloneNode;
  Node.prototype.cloneNode = function () {
    counts.cloneNode += 1;
    return clone.apply(this, arguments);
  };
  for (const name of ["innerHTML", "outerHTML"]) {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, name);
    Object.defineProperty(Element.prototype, name, {
      ...descriptor,
      get() {
        counts[name] += 1;
        return descriptor.get.call(this);
      },
    });
  }
  return counts;
}

const budget = (overrides = {}) =>
  client.normalizeTavernFrameSnapshotBudget(
    { ...DEFAULTS, ...overrides },
    DEFAULTS,
    CEILING,
  );

const collect = (
  root,
  overrides,
  options = { internalScriptMarkers: MARKERS },
) =>
  copy(client.collectTavernFrameDomSnapshot(root, budget(overrides), options));

function reporterSandbox({ persistent = false, body } = {}) {
  const html = client.buildTavernFrameDocument({
    content: "",
    token: "diag-token",
    persistent,
    helperContext: { messages: [] },
    observeMvuView: false,
    runtimeReporting: true,
  });
  const script = html.match(
    /<script data-dsh-tavern-frame>([\s\S]*?)<\/script>/,
  )[1];
  const pending = [],
    reports = [],
    handlers = new Map();
  const parent = {
    postMessage(value) {
      reports.push(copy(value));
    },
  };
  const poisoned = new Proxy(
    {},
    {
      get(_, key) {
        if (key === "cloneNode" || key === "innerHTML" || key === "childNodes")
          throw new Error("默认上报不得访问 body: " + String(key));
        return undefined;
      },
    },
  );
  const context = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    parent,
    document: { body: body || poisoned },
    addEventListener(type, handler) {
      handlers.set(type, (handlers.get(type) || []).concat(handler));
    },
    setTimeout(fn) {
      pending.push(fn);
      return pending.length;
    },
    fetch: () => Promise.reject(new Error("network down")),
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(script, context);
  return {
    context,
    reports,
    parent,
    innerWindow: vm.runInContext("window", context),
    flush() {
      for (const fn of pending.splice(0)) fn();
    },
    emit(type, event) {
      for (const handler of handlers.get(type) || []) handler(event);
    },
  };
}

const context = (revision = 1) => ({
  version: 1,
  stateRevision: revision,
  lifecycleRevision: 1,
  messages: [{ role: "assistant", variables: { hp: revision } }],
  turnMessageIds: { 1: 0 },
  chatVariables: {},
  scriptVariables: {},
});

function frames(extra = {}, hooks = {}) {
  const h = hooks.host || host(),
    calls = [],
    invalidations = [],
    posts = [],
    metrics = [];
  let props = {
    sessionId: "A",
    content: "<p>status</p>",
    turn: 1,
    partIndex: 0,
    eager: true,
    persistent: true,
    helperContext: context(),
    ...extra,
  };
  let handler = () => Promise.resolve({ updated: true });
  const lifecycle = h.client.createTavernMessageFrameLifecycle(props, {
    window: h.window,
    rpc(method, args, sessionId) {
      calls.push({ method, args: copy(args), sessionId });
      return handler(method, args, sessionId);
    },
    invalidate(sessionId) {
      invalidations.push(sessionId);
    },
    diagnostics:
      hooks.diagnostics === undefined
        ? {
            noteFrameRuntime(input) {
              metrics.push(copy(input));
            },
          }
        : hooks.diagnostics,
  });
  const stop = lifecycle.start(() => {});
  function attach(document = lifecycle.snapshot().visibleDocument) {
    const node = {
      contentWindow: {
        postMessage(data) {
          posts.push(copy(data));
        },
      },
    };
    document.ref(node);
    return {
      document,
      node,
      message(type, data = {}, sender = node.contentWindow) {
        h.deliver(node, { type, token: document.token, ...data }, sender);
      },
    };
  }
  return Object.assign({}, h, {
    lifecycle,
    stop,
    attach,
    calls,
    posts,
    invalidations,
    metrics,
    update(patch) {
      props = { ...props, ...patch };
      lifecycle.update(props);
    },
    respond(fn) {
      handler = fn;
    },
  });
}

const light = (token, extra = {}) => ({
  capturedAt: 2,
  dom: "",
  domSnapshot: { status: "not_collected", documentToken: token },
  console: [],
  errors: [],
  network: [],
  ...extra,
});
export {
  source,
  copy,
  tick,
  DEFAULTS,
  CEILING,
  MARKERS,
  host,
  client,
  spyWholeTreeAccess,
  budget,
  collect,
  reporterSandbox,
  context,
  frames,
  light,
};
