// 故事契约 C4（docs/plugin-api-ui.md「故事视图契约」）：开启 storyViewMode 后，
// 故事与剧本的 Chat 使用宿主原生行，独立插件负责楼层；其它模式和未知模式保留上游渲染。
// 浏览器缓存上次设置，首屏在模式尚未确认时不先挂故事 iframe 再卸载。
function createTavernStoryViewMode(host) {
  const key = "dsh-tavern:story-view-mode";
  const listeners = new Set();
  let enabled = false,
    loading = null;
  try {
    enabled = host.localStorage.getItem(key) === "1";
  } catch (_) {}
  function apply(value) {
    const next = value === true;
    try {
      host.localStorage.setItem(key, next ? "1" : "0");
    } catch (_) {}
    if (next === enabled) return;
    enabled = next;
    listeners.forEach(function (listener) {
      listener();
    });
  }
  function refresh() {
    if (!loading)
      loading = rpc("getTavernSettings")
        .then(
          function (result) {
            apply(result && result.settings && result.settings.storyViewMode);
          },
          function () {},
        )
        .then(function () {
          loading = null;
        });
    return loading;
  }
  return Object.freeze({
    enabled: function () {
      return enabled;
    },
    subscribe: function (listener) {
      listeners.add(listener);
      return function () {
        listeners.delete(listener);
      };
    },
    refresh: refresh,
    async set(value) {
      if (typeof value !== "boolean")
        throw new Error("故事视图模式设置必须是布尔值");
      const result = await rpc("updateTavernSettings", {
        patch: { storyViewMode: value },
      });
      apply(result && result.settings && result.settings.storyViewMode);
      return enabled;
    },
    start: function () {
      void refresh();
      // Another tab changed it: its write to the cache reaches this tab as a storage event.
      const onStorage = function (event) {
        if (event.key === key) apply(event.newValue === "1");
      };
      if (typeof host.addEventListener !== "function") return function () {};
      host.addEventListener("storage", onStorage);
      return function () {
        host.removeEventListener("storage", onStorage);
      };
    },
  });
}
const tavernStoryViewMode = createTavernStoryViewMode(window);
// 故事模式目录只返回公开的会话模式；未知会话先保留 Tavern 界面，按需读取轻量目录。
let tavernStoryModeRequest = null;
function tavernStorySessionMode(sessionId) {
  return tavernSessionModes.values[String(sessionId || "")] || "";
}
function readTavernStorySessionMode(sessionId) {
  const known = tavernStorySessionMode(sessionId);
  if (known) return Promise.resolve(known);
  if (!tavernStoryModeRequest) {
    tavernStoryModeRequest = rpc("listSessions")
      .then(function (result) {
        publishSessionModes(result && result.sessions);
      })
      .finally(function () {
        tavernStoryModeRequest = null;
      });
  }
  return tavernStoryModeRequest.then(function () {
    return tavernStorySessionMode(sessionId);
  });
}
function subscribeTavernStorySessionMode(sessionId, listener) {
  let stopped = false;
  const notify = function () {
    if (stopped) return;
    listener(tavernStorySessionMode(sessionId));
  };
  tavernSessionModes.listeners.add(notify);
  notify();
  void readTavernStorySessionMode(sessionId).catch(function () {});
  return function () {
    stopped = true;
    tavernSessionModes.listeners.delete(notify);
  };
}
function tavernStorySessionState(sessionId) {
  const mode = tavernStorySessionMode(sessionId);
  const play = isPlayMode(mode);
  return Object.freeze({
    mode: mode,
    known: mode !== "",
    isPlay: play,
    storyViewActive: tavernStoryViewMode.enabled() && play,
  });
}
function tavernStoryViewActive(sessionId) {
  return (
    tavernStoryViewMode.enabled() &&
    isPlayMode(tavernStorySessionMode(sessionId))
  );
}
// 集中维护聊天行所有权；监听公开主视图与模式目录，不依赖侧栏或被撤下的渲染器。
function whileTavernDrawsChat(register, sessions) {
  return function () {
    let dispose = null;
    let stopped = false;
    function sync() {
      if (stopped) return;
      const sessionId = tavernMainSessionId(sessions);
      const wanted = !tavernStoryViewActive(sessionId);
      if (wanted && !dispose) dispose = register() || function () {};
      else if (!wanted && dispose) {
        const release = dispose;
        dispose = null;
        release();
      }
      if (sessionId && !tavernStorySessionMode(sessionId))
        void readTavernStorySessionMode(sessionId).catch(function () {});
    }
    const stop = tavernStoryViewMode.subscribe(sync);
    const stopSessions =
      sessions && sessions.list && typeof sessions.list.subscribe === "function"
        ? sessions.list.subscribe(sync)
        : function () {};
    tavernSessionModes.listeners.add(sync);
    sync();
    return function () {
      stopped = true;
      stop();
      stopSessions();
      tavernSessionModes.listeners.delete(sync);
      if (dispose) dispose();
      dispose = null;
    };
  };
}
// 楼层操作接管的菜单与 dock 只在开关开启且会话属于游玩组时撤下。
function useTavernStoryViewMode(sessionId) {
  const subscribe = React.useCallback(
    function (notify) {
      const stop = tavernStoryViewMode.subscribe(notify);
      const stopMode = subscribeTavernStorySessionMode(sessionId, notify);
      return function () {
        stop();
        stopMode();
      };
    },
    [sessionId],
  );
  const read = React.useCallback(
    function () {
      return tavernStoryViewActive(sessionId);
    },
    [sessionId],
  );
  return React.useSyncExternalStore(subscribe, read, read);
}
