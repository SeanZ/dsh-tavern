// Settings owns its initial snapshot; each editor saves only its own resource.
function createGlobalSettingsModule({ React, rpc, notifySettingsChanged, TavernDefaultModelSetting, TavernConversationWritingSkills, DisplayPreferencesSettings, HeaderItemsSettings, CandidatePreferencesSettings, PromptTemplateSettingsEntry, ContextCompactionSettings, TavernUserPluginsSettings }) {
    function GlobalPlayDefaults({ settings }) {
        const h = React.createElement;
        const [data, setData] = React.useState(null), [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState("");
        React.useEffect(() => {
            let active = true;
            Promise.all([rpc("listPresets"), rpc("getUserPreferenceProfile", { globalDefaults: true })]).then(([presets, profile]) => {
                if (active) setData({ ...settings.defaultPlaySettings, presets: presets.presets || [], preset: presets.activePresetPath || "", profile: profile.userProfile });
            }, err => { if (active) setMessage("读取失败：" + err.message); });
            return () => { active = false; };
        }, []);
        async function save(patch, method, args) {
            setBusy(true); setMessage("");
            try {
                const result = await rpc(method || "updateTavernSettings", args || { patch: { defaultPlaySettings: patch } });
                if (method === "selectPreset") setData(current => ({ ...current, preset: args.path }));
                else if (method === "manageUserPreferenceProfile") {
                    const profile = await rpc("getUserPreferenceProfile", { globalDefaults: true });
                    setData(current => ({ ...current, profile: profile.userProfile }));
                } else setData(current => ({ ...current, ...result.settings.defaultPlaySettings }));
                setMessage("已保存，新游戏继承此设置，已有游戏保持不变。");
            } catch (err) { setMessage("保存失败：" + err.message); }
            finally { setBusy(false); }
        }
        const disabled = !data || busy;
        function toggle(key, title, help, task) {
            return h("label", { key, className: "dsh-tavern-settings-row dsh-tavern-background-task" },
                h("span", { className: "dsh-tavern-settings-copy" }, h("strong", { className: "dsh-tavern-settings-title" }, title), h("span", { className: "dsh-tavern-settings-desc" }, help)),
                h("input", { type: "checkbox", role: "switch", "aria-label": title, disabled, checked: task ? data?.backgroundTasks[key] === true : data?.[key] === true, onChange: event => save(task ? { backgroundTasks: { [key]: event.target.checked } } : { [key]: event.target.checked }) }));
        }
        return h("div", { className: "dsh-tavern-settings-section dsh-local-settings dsh-tavern-global-defaults" },
            h("section", { className: "dsh-local-section" }, h("h3", null, "游玩"),
                h("label", { className: "dsh-local-field" }, "默认玩家称呼", h("input", { key: data?.playerName, defaultValue: data?.playerName || "", disabled, maxLength: 80, onBlur: event => { if (event.target.value !== data.playerName) save({ playerName: event.target.value }); } })),
                h("label", { className: "dsh-local-field" }, "默认状态栏位置", h("select", { disabled, value: data?.statusBarPlacement || "sidebar", onChange: event => save({ statusBarPlacement: event.target.value }) }, h("option", { value: "sidebar" }, "侧边栏"), h("option", { value: "body" }, "正文下方"))),
                h("label", { className: "dsh-local-field" }, "默认预设", h("select", { disabled, value: data?.preset || "", onChange: event => save(null, "selectPreset", { path: event.target.value }) }, h("option", { value: "" }, "不使用酒馆预设"), (data?.presets || []).filter(item => item.valid && item.recognized).map(item => h("option", { key: item.path, value: item.path }, item.title)))),
                h("label", { className: "dsh-local-field" }, "默认长期偏好", h("select", { disabled, value: data?.profile.defaultProfileId || "", onChange: event => save(null, "manageUserPreferenceProfile", { action: "default", profileId: event.target.value }) }, h("option", { value: "" }, "不启用"), (data?.profile.profiles || []).filter(item => item.hasConfirmed).map(item => h("option", { key: item.id, value: item.id }, item.name))))),
            // Same names and order as 功能 in 本局设置, where each game changes them later.
            h("section", { className: "dsh-local-section" }, h("h3", null, "功能"),
                toggle("variables", "变量结算", "MVU 卡建议开启；普通卡不执行此任务。", true), toggle("posture", "人物姿势", "总结本轮结束时人物的位置、动作和姿势。", true),
                toggle("styleReference", "文风联想", "仅自由模式。每轮后台凭记忆摘一段风格相近的小说原文，供下一轮正文借鉴笔调。多一次后台请求。", true),
                toggle("webSearchEnabled", "联网搜索", "允许新游戏的前台和后台按需搜索。")),
            message ? h("p", { role: "status" }, message) : null);
    }

    // Global switches: they apply to every game from its next turn, not per-game preferences.
    function SettingSwitch({ settings, name, title, description }) {
        const h = React.createElement;
        const [enabled, setEnabled] = React.useState(settings[name] === true), [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState("");
        async function save(value) {
            setBusy(true); setMessage("");
            try {
                const result = await rpc("updateTavernSettings", { patch: { [name]: value } });
                setEnabled(result.settings[name] === true);
                notifySettingsChanged();
                setMessage("已保存，所有游戏下一轮生效");
            } catch (err) { setMessage("保存失败：" + String(err.message || err)); }
            finally { setBusy(false); }
        }
        return h("section", { className: "dsh-tavern-settings-group" },
            h("label", { className: "dsh-tavern-settings-row dsh-tavern-background-task" },
                h("span", { className: "dsh-tavern-settings-copy" },
                    h("strong", null, title),
                    h("p", { className: "dsh-tavern-settings-desc" }, description)),
                h("input", { type: "checkbox", role: "switch", "aria-label": title, checked: enabled, disabled: busy, onChange: event => save(event.target.checked) })),
            message ? h("div", { className: "dsh-tavern-settings-row", role: "status" }, h("span", { className: "dsh-tavern-settings-desc" }, message)) : null);
    }

    function WebAccessSettings({ settings }) {
        const h = React.createElement;
        const [config, setConfig] = React.useState(settings.webAccess || { sources: ["bing", "ddg"], searxngUrl: "", searxngEngines: [], proxyUrl: "", sourceProxies: {}, fetchEnabled: false });
        const [busy, setBusy] = React.useState(false), [notice, setNotice] = React.useState(""), [error, setError] = React.useState(""), [status, setStatus] = React.useState(null);
        const labels = { bing: "Bing", ddg: "DuckDuckGo", searxng: "SearXNG" };
        const [engines, setEngines] = React.useState(config.searxngEngines.join(","));
        React.useEffect(() => {
            let live = true;
            rpc("getWebSearchStatus").then(value => { if (live) setStatus(value); }, err => { if (live) setError(err.message); });
            return () => { live = false; };
        }, []);
        const change = patch => setConfig(value => ({ ...value, ...patch }));
        async function save(test) {
            setBusy(true); setError(""); setNotice("");
            try {
                const result = await rpc("updateTavernSettings", { patch: { webAccess: { ...config, searxngEngines: engines.split(",").map(v => v.trim()).filter(Boolean) } } });
                setConfig(result.settings.webAccess); notifySettingsChanged(); setNotice("卡片工作台搜索设置已保存，后续调用生效。");
                if (test) {
                    const checked = await rpc("testWebSearch");
                    setNotice("已保存，内置搜索测试成功，返回 " + checked.count + " 条结果。");
                }
                setStatus(await rpc("getWebSearchStatus"));
            } catch (err) { setError(String(err.message || err)); }
            finally { setBusy(false); }
        }
        async function activate() {
            setBusy(true); setError("");
            try { setStatus(await rpc("useBuiltinWebSearch")); setNotice("已切换到内置搜索。"); }
            catch (err) { setError(String(err.message || err)); }
            finally { setBusy(false); }
        }
        function copy(title, description) {
            return h("span", { className: "dsh-tavern-settings-copy" }, h("strong", null, title), description ? h("span", { className: "dsh-tavern-settings-desc" }, description) : null);
        }
        function field(title, value, onChange, placeholder, description) {
            return h("label", { className: "dsh-local-field" }, copy(title, description), h("input", { "aria-label": title, value, disabled: busy, placeholder, onChange: e => onChange(e.target.value) }));
        }
        function move(source, step) {
            const next = config.sources.slice(), at = next.indexOf(source), target = at + step;
            if (target < 0 || target >= next.length) return;
            [next[at], next[target]] = [next[target], next[at]]; change({ sources: next });
        }
        return h("div", { className: "dsh-tavern-web-settings", "aria-label": "卡片工作台搜索设置" },
            h("section", { className: "dsh-tavern-settings-group" },
                h("div", { className: "dsh-tavern-settings-row" }, copy("搜索服务", "用于工作台查找作品、人物和世界观资料。"),
                    h("span", { className: "dsh-tavern-settings-desc", role: "status" }, status ? (status.provider === "tavern-search" ? "酒馆内置搜索" : status.provider || "未选择") : "正在读取…"),
                    status && status.provider !== "tavern-search" ? h("button", { type: "button", className: "dsh-tavern-btn", disabled: busy, onClick: activate }, "使用内置搜索") : null),
                h("div", { className: "dsh-tavern-settings-row" }, copy("搜索源", "按顺序尝试，当前来源不可用时使用下一项。")),
                [...config.sources, ...Object.keys(labels).filter(source => !config.sources.includes(source))].map(source => {
                    const at = config.sources.indexOf(source);
                    return h("div", { key: source, className: "dsh-tavern-settings-row" },
                        h("label", { className: "dsh-tavern-web-source dsh-tavern-background-task" },
                            h("input", { type: "checkbox", role: "switch", "aria-label": labels[source], disabled: busy, checked: at >= 0, onChange: e => change({ sources: e.target.checked ? [...config.sources, source] : config.sources.filter(s => s !== source) }) }),
                            h("span", null, labels[source])),
                        at >= 0 ? h("span", { className: "dsh-tavern-web-actions" },
                            h("button", { type: "button", className: "dsh-tavern-btn", "aria-label": labels[source] + "优先", disabled: busy || at === 0, onClick: () => move(source, -1) }, "上移"),
                            h("button", { type: "button", className: "dsh-tavern-btn", "aria-label": labels[source] + "后移", disabled: busy || at === config.sources.length - 1, onClick: () => move(source, 1) }, "下移")) : null);
                })),
            h("details", { className: "dsh-tavern-settings-group dsh-tavern-header-settings-group" },
                h("summary", { className: "dsh-tavern-header-summary" }, h("strong", { className: "dsh-tavern-settings-title" }, "SearXNG 配置"), h("span", { className: "dsh-tavern-header-summary-meta" }, "自定义搜索源"), h("span", { className: "dsh-tavern-header-summary-chevron", "aria-hidden": true }, "▾")),
                field("SearXNG 实例地址", config.searxngUrl, value => change({ searxngUrl: value }), "https://你的实例地址"),
                field("SearXNG 引擎", engines, setEngines, "例如 wikipedia,bing", "用逗号分隔；留空使用实例默认。")),
            h("section", { className: "dsh-tavern-settings-group" },
                h("label", { className: "dsh-tavern-settings-row dsh-tavern-background-task" }, copy("允许读取网页正文", "让工作台继续阅读搜索结果中的网页，核对原文并保留出处。"), h("input", { type: "checkbox", role: "switch", "aria-label": "允许读取网页正文", checked: config.fetchEnabled, disabled: busy, onChange: e => change({ fetchEnabled: e.target.checked }) }))),
            h("details", { className: "dsh-tavern-settings-group dsh-tavern-header-settings-group" },
                h("summary", { className: "dsh-tavern-header-summary" }, h("strong", { className: "dsh-tavern-settings-title" }, "搜索代理"), h("span", { className: "dsh-tavern-header-summary-meta" }, "高级设置"), h("span", { className: "dsh-tavern-header-summary-chevron", "aria-hidden": true }, "▾")),
                field("默认搜索代理", config.proxyUrl, value => change({ proxyUrl: value }), "http://127.0.0.1:7890", "留空直连。网页正文读取沿用 DSH 的代理设置。"),
                Object.keys(labels).map(source => h(React.Fragment, { key: source },
                    h("label", { className: "dsh-tavern-settings-row dsh-tavern-background-task" }, copy(labels[source] + " 单独设置代理"), h("input", { type: "checkbox", role: "switch", "aria-label": labels[source] + " 单独设置代理", disabled: busy, checked: Object.hasOwn(config.sourceProxies, source), onChange: e => {
                        const proxies = { ...config.sourceProxies }; if (e.target.checked) proxies[source] = ""; else delete proxies[source]; change({ sourceProxies: proxies });
                    } })),
                    Object.hasOwn(config.sourceProxies, source) ? field(labels[source] + "代理地址", config.sourceProxies[source], value => change({ sourceProxies: { ...config.sourceProxies, [source]: value } }), "留空强制直连") : null))),
            h("div", { className: "dsh-tavern-web-actions dsh-tavern-web-save" },
                h("button", { type: "button", className: "dsh-tavern-btn", disabled: busy, onClick: () => save(false) }, "保存搜索设置"),
                h("button", { type: "button", className: "dsh-tavern-btn", disabled: busy, onClick: () => save(true) }, "保存并测试搜索")),
            h("p", { className: "dsh-tavern-gs-notice" }, "游玩中开启本局联网搜索时，也会复用这些搜索源。"),
            notice ? h("p", { className: "dsh-tavern-gs-notice", role: "status" }, notice) : null,
            error ? h("p", { className: "dsh-tavern-settings-error", role: "alert" }, error) : null,
            (status?.attempts || []).length ? h("p", { className: "dsh-tavern-gs-notice" }, "最近搜索：" + status.attempts.map(a => (labels[a.source] || a.source) + "：" + (a.ok ? "成功" : a.error)).join("；")) : null);
    }

    function TavernSettingsSection() {
        const [state, setState] = React.useState({ loading: true, busy: false, defaultForegroundModel: null, defaultBackgroundModel: null, defaultWorkbenchModel: null, notice: "", settings: null, modelCatalog: [], error: "" });
        React.useEffect(function () {
            let active = true;
            rpc("getTavernSettings").then(function (result) {
                if (active) setState({ loading: false, busy: false, defaultForegroundModel: result.settings?.defaultForegroundModel || null, defaultBackgroundModel: result.settings?.defaultBackgroundModel || null, defaultWorkbenchModel: result.settings?.defaultWorkbenchModel || null, notice: "", settings: result.settings, modelCatalog: Array.isArray(result.modelCatalog) ? result.modelCatalog : [], error: "" });
            }, function (error) {
                if (active) setState(function (current) { return Object.assign({}, current, { loading: false, busy: false, error: String(error && error.message || error) }); });
            });
            return function () { active = false; };
        }, []);
        async function saveDefault(name, selection) {
            if (state.loading || state.busy) return;
            setState(current => ({ ...current, busy: true, error: "", notice: "" }));
            try {
                const result = await rpc("updateTavernSettings", { patch: { [name]: selection } });
                notifySettingsChanged();
                setState(current => ({ ...current, [name]: result.settings[name], busy: false, notice: name === "defaultWorkbenchModel" ? "已保存，下次新建工作台对话生效" : "已保存，下次新游戏生效" }));
            } catch (err) { setState(current => ({ ...current, busy: false, error: String(err.message || err) })); }
        }
        const h = React.createElement;
        function group(title, desc, ...children) {
            return h("section", { className: "dsh-tavern-gs-group", "aria-label": title },
                h("header", { className: "dsh-tavern-gs-head" }, h("h2", null, title), desc ? h("p", null, desc) : null),
                ...children);
        }
        return h("div", { className: "dsh-tavern-settings-section dsh-tavern-global-settings" },
            h("p", { className: "dsh-tavern-gs-notice" }, "遇到问题或想交流玩法，欢迎加入 ",
                h("a", { href: "https://discord.gg/hYAEjKnpra", target: "_blank", rel: "noopener noreferrer" }, "Discord 交流群"),
                "。本项目没有官方的 QQ 群、微信群。"),
            group("默认模型", "用于新游戏和新的卡片工作台对话，已有对话保持当前配置。建议使用 High 推理强度；Max 容易过度思考、增加等待。",
            h("div", { className: "dsh-tavern-gs-card" },
            React.createElement(TavernDefaultModelSetting, { label: "默认前台模型", title: "前台模型", description: "写正文、扮演角色，直接决定剧情质量", fallback: "使用 DSH 默认模型", selection: state.defaultForegroundModel, catalog: state.modelCatalog, disabled: state.loading || state.busy, onChange: selection => saveDefault("defaultForegroundModel", selection) }),
            React.createElement(TavernDefaultModelSetting, { label: "默认后台模型", title: "后台模型", description: "变量结算、世界书筛选、候选回复、手机消息等幕后任务", fallback: "跟随前台", selection: state.defaultBackgroundModel, catalog: state.modelCatalog, disabled: state.loading || state.busy, onChange: selection => saveDefault("defaultBackgroundModel", selection) }),
            React.createElement(TavernDefaultModelSetting, { label: "卡片工作台默认模型", title: "工作台模型", description: "卡片工作台里创建和修改人物卡", fallback: "跟随前台", selection: state.defaultWorkbenchModel, catalog: state.modelCatalog, disabled: state.loading || state.busy, onChange: selection => saveDefault("defaultWorkbenchModel", selection) })),
            state.notice ? h("p", { className: "dsh-tavern-gs-notice", role: "status" }, state.notice) : null),
            // Grouped by what a setting governs; each group's note says when it takes effect.
            group("开局默认", "新游戏开局时继承，开局后可在本局设置中单独修改；已有游戏不受影响。",
                state.settings ? h(GlobalPlayDefaults, { settings: state.settings }) : null,
                h(TavernConversationWritingSkills, { globalDefaults: true })),
            // 对话气泡 (castPresentation) lives in 舞台设置 › 基础设置 with the other stage switches.
            group("剧情", "所有游戏都按这些设置，下一轮生效。",
                h(ContextCompactionSettings),
                // Off by default: it adds a background model request after every reply.
                state.settings ? h(SettingSwitch, { settings: state.settings, name: "candidateAutoGenerate", title: "自动生成候选项",
                    description: "打开后每轮会多一次后台请求：正文写完，酒馆在后台自动生成这一轮的候选项，不用再点「生成候选项」。只对打开后的新回复生效，失败时可手动重试。" }) : null),
            group("卡片工作台搜索", "为制卡和改卡补充作品资料，设置搜索来源、网页读取与连接方式。", state.settings ? h(WebAccessSettings, { settings: state.settings }) : null),
            group("显示与交互", "对所有游戏生效，只改界面，不影响正文和存档。",
                state.settings ? h(SettingSwitch, { settings: state.settings, name: "autoOpenStatusPanel", title: "进入游戏时打开酒馆状态",
                    description: "进入或切换到一局游戏时，右侧面板自动展开并显示本局设置和酒馆状态。关闭后右侧面板保持你上次的样子。" }) : null,
                h(DisplayPreferencesSettings),
                h(CandidatePreferencesSettings),
                // Most players never need this; it sits last, folded.
                h(HeaderItemsSettings)),
            group("高级", "",
                state.settings ? h(SettingSwitch, { settings: state.settings, name: "storyInputToolCall", title: "输入走工具调用",
                    description: "把发给模型的历史（此前的玩家消息和正文）以 submit_story 工具参数的形式回放，而不是普通对话文字；可降低续写被拒答。只影响请求，本轮输入、存档和界面保持不变。需要模型支持工具调用。" }) : null,
                state.settings ? h(SettingSwitch, { settings: state.settings, name: "storyOutputToolCall", title: "输出走工具调用",
                    description: "让模型通过 submit_story 提交本轮正文，可缓解 Gemini 等模型在正文中途截断或拒答。需要模型支持工具调用；正文生成完成后一次性显示。" }) : null,
                h(PromptTemplateSettingsEntry)),
            state.error ? React.createElement("div", { className: "dsh-tavern-settings-error", role: "alert" }, "保存失败：" + state.error) : null
        );
    }

    // Installing and updating plugins is management, not a setting: it gets its own page.
    function TavernPluginsSettingsSection() {
        const h = React.createElement;
        return h("div", { className: "dsh-tavern-settings-section dsh-tavern-global-settings" },
            h("section", { className: "dsh-tavern-gs-group", "aria-label": "酒馆插件" },
                h("header", { className: "dsh-tavern-gs-head" }, h("h2", null, "酒馆插件"),
                    h("p", null, "给酒馆加功能：粘贴插件作者的 GitHub 地址即可安装。"),
                    h("p", null, "不支持 SillyTavern 插件，仅支持 DSH 插件和 DSH Tavern 插件。")),
                h(TavernUserPluginsSettings)));
    }

    return { TavernSettingsSection, TavernPluginsSettingsSection };
}
