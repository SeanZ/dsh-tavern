import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Fork contract C4: storyViewMode on leaves the chat rows to the host.
const source = await readFile(
  new URL("../tavern-plugin/lib/client.js", import.meta.url),
  "utf8",
);
const React = {
  createElement: (type, props) => ({ type, props }),
  Fragment: "Fragment",
  memo: (value) => value,
  forwardRef: (value) => value,
  createContext: () => ({}),
};
function loadClient({
  cached = null,
  settings = { storyViewMode: false },
  modes = [{ sessionId: "story", mode: "story" }],
} = {}) {
  let descriptor;
  const storage = new Map(
    cached === null ? [] : [["dsh-tavern:story-view-mode", cached]],
  );
  const listeners = new Map();
  const window = {
    __ModuleLoader__: {
      load(value) {
        descriptor = value;
      },
    },
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
    },
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  };
  const calls = [];
  const fetch = async (url, request) => {
    const { _performance, ...args } = JSON.parse(request.body);
    calls.push({ method: url.split("/").pop(), args });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true,
          settings: args.patch ? { ...settings, ...args.patch } : settings,
          sessions: modes,
        }),
    };
  };
  vm.runInNewContext(
    source.replace(
      "exports.tavernStoryViewMode = tavernStoryViewMode;",
      "exports.sessionModeListeners = tavernSessionModes.listeners; exports.publishSessionMode = publishSessionMode; exports.publishSessionModes = publishSessionModes; exports.tavernStorySessionState = tavernStorySessionState; exports.tavernStoryViewMode = tavernStoryViewMode;",
    ),
    { window, fetch, performance, console },
  );
  return {
    client: descriptor.factory((name) => (name === "react" ? React : {})),
    storage,
    listeners,
    calls,
  };
}
function register(client, sessions = sessionList("story").sessions) {
  const live = new Map();
  const releases = [];
  const ctx = {
    sessions,
    get: () => null,
    effect(run, label) {
      if (label === "dsh-tavern: game script owner") return () => {};
      try {
        const release = run();
        if (release) releases.push(release);
        return release;
      } catch (_) {}
    },
  };
  const slots = {
    inject: (_name, run) => run(),
    register(options) {
      const id = options.name + ":" + (options.key || options.id);
      live.set(id, (live.get(id) || 0) + 1);
      return () => live.set(id, live.get(id) - 1);
    },
  };
  client.createTavernAssistantRendererFeatureModule().register({ ctx, slots });
  const count = (id) => live.get(id) || 0;
  count.dispose = () =>
    releases
      .splice(0)
      .reverse()
      .forEach((release) => release());
  return count;
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("故事视图模式关闭（默认）时照常注册聊天行渲染器与助手行按钮", () => {
  const { client } = loadClient();
  const count = register(client);
  for (const id of [
    "conversation.chat.node:assistant-step",
    "conversation.chat.node:user",
    "conversation.chat.assistant-actions:dsh-tavern-fork",
    "conversation.chat.assistant-actions:dsh-tavern-illustrate",
  ])
    assert.equal(count(id), 1, id);
});

test("故事视图模式开启时不注册游玩聊天行，宿主原生渲染；会话脚本运行时照常", async () => {
  const { client } = loadClient({ cached: "1" });
  const count = register(client);
  await tick();
  for (const id of [
    "conversation.chat.node:assistant-step",
    "conversation.chat.node:user",
    "conversation.chat.assistant-actions:dsh-tavern-fork",
    "conversation.chat.assistant-actions:dsh-tavern-illustrate",
  ])
    assert.equal(count(id), 0, id);
  assert.equal(
    count("conversation.session.header.actions:dsh-tavern-script-runtime"),
    1,
    "人物卡脚本运行时（状态栏等）不属于聊天行",
  );
});

test("设置读到后切换注册，跨标签页变更也生效", async () => {
  const { client, storage, listeners, calls } = loadClient({
    settings: { storyViewMode: true },
  });
  const count = register(client);
  assert.equal(count("conversation.chat.node:user"), 1);
  await client.tavernStoryViewMode.refresh();
  assert.ok(calls.some((call) => call.method === "getTavernSettings"));
  assert.equal(
    count("conversation.chat.node:user"),
    0,
    "开启后撤下 Tavern 行渲染器",
  );
  assert.equal(count("conversation.chat.assistant-actions:dsh-tavern-fork"), 0);
  assert.equal(
    storage.get("dsh-tavern:story-view-mode"),
    "1",
    "缓存供下次首屏使用",
  );
  const stop = client.tavernStoryViewMode.start();
  await tick();
  listeners.get("storage")({
    key: "dsh-tavern:story-view-mode",
    newValue: "0",
  });
  assert.equal(
    count("conversation.chat.node:user"),
    1,
    "另一标签页关闭后重新注册，且只注册一份",
  );
  assert.equal(count("conversation.chat.node:assistant-step"), 1);
  stop();
});

test("set 写入全局设置并立即切换", async () => {
  const { client, calls } = loadClient({ settings: { storyViewMode: true } });
  const count = register(client);
  assert.equal(await client.tavernStoryViewMode.set(true), true);
  assert.deepEqual(
    calls.find((call) => call.method === "updateTavernSettings"),
    {
      method: "updateTavernSettings",
      args: { patch: { storyViewMode: true } },
    },
  );
  assert.equal(count("conversation.chat.node:assistant-step"), 0);
  await assert.rejects(client.tavernStoryViewMode.set("yes"), /布尔值/);
});

// 输入框 dock 的「重新生成正文」面板（RegenPanel 与编辑正文面板）与候选项面板（下一步行动、重新生成候选项）
// 只在 Tavern 画聊天行时注册；候选项操作条保留（更多菜单、停止后台、压缩、插件按钮），只撤下候选项按钮。
function registerDock(client, sessions = sessionList("story").sessions) {
  const live = new Map();
  const ctx = {
    sessions,
    get: () => null,
    betterSidebar: { registerTab: () => () => {} },
    effect(run) {
      try {
        return run();
      } catch (_) {}
    },
  };
  const slots = {
    inject: (_name, run) => run(),
    register(options) {
      const id = options.name + ":" + options.id;
      live.set(id, (live.get(id) || 0) + 1);
      return () => live.set(id, live.get(id) - 1);
    },
  };
  client.playControlsFeature.register({ ctx, slots });
  return (id) => live.get("conversation.input.dock:" + id) || 0;
}
const sharedDock = ["dsh-tavern-candidate-actions"];
const chatDock = [
  "dsh-tavern-question",
  "dsh-tavern-candidate-guide",
  "dsh-tavern-regen",
];

test("故事视图模式关闭时 dock 照常注册重新生成正文与候选项面板", () => {
  const count = registerDock(loadClient().client);
  for (const id of [...sharedDock, ...chatDock]) assert.equal(count(id), 1, id);
});

test("故事视图模式开启时不注册重新生成正文与候选项面板，操作条保留；开关变化即时生效", async () => {
  const { client, listeners } = loadClient({
    cached: "1",
    settings: { storyViewMode: true },
  });
  const count = registerDock(client);
  await tick();
  for (const id of chatDock) assert.equal(count(id), 0, id);
  for (const id of sharedDock) assert.equal(count(id), 1, id);
  const stop = client.tavernStoryViewMode.start();
  await tick();
  listeners.get("storage")({
    key: "dsh-tavern:story-view-mode",
    newValue: "0",
  });
  for (const id of chatDock) assert.equal(count(id), 1, "关闭后重新注册 " + id);
  listeners.get("storage")({
    key: "dsh-tavern:story-view-mode",
    newValue: "1",
  });
  for (const id of chatDock) assert.equal(count(id), 0, "再开启后撤下 " + id);
  stop();
});

test("候选项操作条在故事视图模式下不放「生成候选项」按钮，其余按钮源码路径不变", async () => {
  const source = await readFile(
    new URL(
      "../tavern-plugin/src/client/features/play-controls.js",
      import.meta.url,
    ),
    "utf8",
  );
  const body = source.slice(
    source.indexOf("function CandidateDockActions("),
    source.indexOf("function observeTurnErrorProjection("),
  );
  assert.match(
    body,
    /const storyView = useTavernStoryViewMode\(props\.sessionId\);/,
  );
  assert.match(
    body,
    /latestMessageId && !storyView \? React\.createElement\(CandidateAction,/,
  );
  assert.match(body, /React\.createElement\(TavernPluginComposerActions,/);
  assert.match(body, /React\.createElement\(TavernMoreActions, props\)/);
});

// 用公开 list 快照模拟主视图 retain 转移，列表成员不变时也必须通知注册所有权。
function sessionList(current) {
  const listeners = new Set();
  let active = current;
  const list = {
    getSnapshot() {
      return {
        byId: Object.fromEntries(
          ["card", "story", "script", "read", "one-shot"].map((id) => [
            id,
            { id, retainedBy: { mainView: id === active ? 1 : 0 } },
          ]),
        ),
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    sessions: { list, subagentAddress: () => null, binding: () => undefined },
    listeners,
    select(id) {
      active = id;
      for (const listener of [...listeners]) listener();
    },
  };
}

test("故事模式首屏未知会话保留 Tavern 行，mode 读到 card 后保留制卡渲染；主视图切换不依赖侧栏或聊天行", async () => {
  const { client } = loadClient({
    cached: "1",
    settings: { storyViewMode: true },
    modes: ["card", "story", "script", "read", "one-shot"].map((mode) => ({
      sessionId: mode,
      mode,
    })),
  });
  const catalog = sessionList("card");
  const count = register(client, catalog.sessions);
  assert.equal(
    count("conversation.chat.node:assistant-step"),
    1,
    "未知模式保留 Tavern 渲染",
  );
  await tick();
  assert.equal(
    count("conversation.chat.node:assistant-step"),
    1,
    "独立模式请求完成后制卡 presenter 的渲染器可用",
  );
  assert.equal(count("conversation.chat.node:user"), 1);
  for (const mode of ["story", "script", "card", "story", "card"]) {
    catalog.select(mode);
    assert.equal(
      count("conversation.chat.node:assistant-step"),
      mode === "card" ? 1 : 0,
      mode,
    );
    assert.equal(
      count("conversation.chat.node:user"),
      mode === "card" ? 1 : 0,
      mode,
    );
  }
  count.dispose();
  assert.equal(catalog.listeners.size, 0, "所有主视图监听释放");
  assert.equal(count("conversation.chat.node:assistant-step"), 0);
  catalog.select("card");
  assert.equal(
    count("conversation.chat.node:assistant-step"),
    0,
    "释放后不能重挂",
  );
});

test("制卡与故事模式切换后设置开关即时生效且不重复注册", async () => {
  const { client } = loadClient({
    cached: "1",
    settings: { storyViewMode: false },
    modes: [
      { sessionId: "card", mode: "card" },
      { sessionId: "story", mode: "story" },
    ],
  });
  const catalog = sessionList("card");
  const count = register(client, catalog.sessions);
  await tick();
  assert.equal(count("conversation.chat.node:assistant-step"), 1);
  await client.tavernStoryViewMode.set(false);
  assert.equal(
    count("conversation.chat.node:assistant-step"),
    1,
    "关闭故事模式不叠加一份制卡渲染",
  );
  catalog.select("story");
  assert.equal(
    count("conversation.chat.node:assistant-step"),
    1,
    "关闭时故事使用 Tavern 行",
  );
  await client.tavernStoryViewMode.set(true);
  assert.equal(
    count("conversation.chat.node:assistant-step"),
    0,
    "开启时撤下故事渲染",
  );
  catalog.select("card");
  assert.equal(
    count("conversation.chat.node:assistant-step"),
    1,
    "开启时制卡渲染保留",
  );
  await client.tavernStoryViewMode.set(false);
  assert.equal(
    count("conversation.chat.node:assistant-step"),
    1,
    "制卡开关重复切换不叠加",
  );
  count.dispose();
});

test("模式契约直接给 known/isPlay/接管状态；新建模式不会被迟到列表覆盖，释放后不回调", async () => {
  const { client } = loadClient({
    cached: "1",
    modes: [{ sessionId: "new", mode: "story" }],
  });
  const service = client.createTavernStoryService({
    sessions: {},
    actions: { interactions: {} },
  });
  const states = [];
  const stop = service.subscribeSessionMode("new", (state) =>
    states.push(JSON.parse(JSON.stringify(state))),
  );
  assert.deepEqual(states[0], {
    mode: "",
    known: false,
    isPlay: false,
    storyViewActive: false,
  });
  client.publishSessionMode("new", "card");
  const current = await service.readSessionMode("new");
  assert.equal(
    current.mode,
    "card",
    "首次列表的旧 story 不能覆盖明确的新 card",
  );
  assert.equal(current.isPlay, false);
  client.publishSessionModes([{ sessionId: "new", mode: "story" }]);
  assert.equal((await service.readSessionMode("new")).mode, "card");
  client.publishSessionMode("new", "script");
  assert.equal(states.at(-1).storyViewActive, true);
  await client.tavernStoryViewMode.set(false);
  assert.equal(states.at(-1).isPlay, true);
  assert.equal(states.at(-1).storyViewActive, false);
  const copiedModes = [...client.sessionModeListeners];
  stop();
  const count = states.length;
  for (const listener of copiedModes) listener();
  client.publishSessionMode("new", "story");
  await client.tavernStoryViewMode.set(true);
  await tick();
  assert.equal(states.length, count, "注销后模式、开关及迟到请求都不能回调");
});

test("未知、card、read、one-shot 保留 renderer 和 dock；只有开启的 story/script 撤下", async () => {
  const modes = ["card", "story", "script", "read", "one-shot"];
  for (const mode of modes) {
    const { client } = loadClient({
      cached: "1",
      settings: { storyViewMode: true },
      modes: modes.map((mode) => ({ sessionId: mode, mode })),
    });
    const catalog = sessionList(mode);
    const count = register(client, catalog.sessions);
    const dock = registerDock(client, catalog.sessions);
    await tick();
    const wanted = mode === "story" || mode === "script" ? 0 : 1;
    assert.equal(count("conversation.chat.node:assistant-step"), wanted, mode);
    for (const id of chatDock) assert.equal(dock(id), wanted, mode + ":" + id);
    count.dispose();
  }
});

test("实际 useTavernSessionMode 消费者读到合并后的模式目录，迟到列表不能闪回", async () => {
  const host = await readFile(
    new URL(
      "../tavern-plugin/src/client/runtime/host-artifacts.js",
      import.meta.url,
    ),
    "utf8",
  );
  const modeSource = host.slice(
    0,
    host.indexOf("function escapeOpeningPreviewText"),
  );
  const seen = [];
  const context = vm.createContext({
    React: {
      useState: (value) => [
        value,
        (next) => seen.push(JSON.parse(JSON.stringify(next))),
      ],
      useEffect: (run) => run(),
    },
    rpc: async () => ({ sessions: [{ sessionId: "new", mode: "story" }] }),
  });
  vm.runInContext(
    modeSource +
      '; publishSessionMode("new", "card"); useTavernSessionMode("new");',
    context,
  );
  await tick();
  assert.equal(seen.at(-1).new, "card");
});

test("未知模式保留非游玩语义，初次请求完成前退订不会收到迟到回调", async () => {
  const { client } = loadClient({
    cached: "1",
    modes: [{ sessionId: "blank" }],
  });
  const service = client.createTavernStoryService({
    sessions: {},
    actions: { interactions: {} },
  });
  const states = [];
  const stop = service.subscribeSessionMode("blank", (state) =>
    states.push(state),
  );
  assert.equal(states[0].known, false);
  assert.equal(states[0].isPlay, false);
  stop();
  await tick();
  assert.equal(states.length, 1);
  assert.equal(service.sessionMode("blank").known, false);
  assert.equal(service.sessionMode("blank").storyViewActive, false);
});

test("宿主已复制的主会话通知在释放后迟到，也不能重挂 slot", async () => {
  const { client } = loadClient({
    cached: "1",
    modes: [
      { sessionId: "story", mode: "story" },
      { sessionId: "card", mode: "card" },
    ],
  });
  const catalog = sessionList("story");
  const count = register(client, catalog.sessions);
  await tick();
  assert.equal(count("conversation.chat.node:assistant-step"), 0);
  const copied = [...catalog.listeners];
  count.dispose();
  catalog.select("card");
  for (const listener of copied) listener();
  assert.equal(count("conversation.chat.node:assistant-step"), 0);
  assert.equal(catalog.listeners.size, 0);
});
