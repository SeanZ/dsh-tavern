// 界面皮肤: the active imported skin is one <style> appended after Tavern's own
// stylesheet, so its rules win at equal specificity. Every browser of this profile
// reads it on load; a change in settings re-applies it here at once.
const TAVERN_INTERFACE_SKIN_ID = "dsh-tavern-plugin/interface-skin";
const TAVERN_INTERFACE_SKIN_EVENT = "dsh-tavern-interface-skin-changed";
function installTavernInterfaceSkin(doc, css) {
    let style = doc.querySelector('style[data-plugin-css="' + TAVERN_INTERFACE_SKIN_ID + '"]');
    if (!css) { if (style) style.remove(); return; }
    if (!style) {
        style = doc.createElement("style");
        style.dataset.plugin = "dsh-tavern-plugin";
        style.dataset.pluginCss = TAVERN_INTERFACE_SKIN_ID;
    }
    if (style.textContent !== css) style.textContent = css;
    // Last in <head>, after Tavern's stylesheet and any host style added since.
    if (style !== doc.head.lastElementChild) doc.head.appendChild(style);
}

function createInterfaceSkinModule({ React, rpc }) {
    function applyActiveInterfaceSkin() {
        return rpc("getActiveInterfaceSkin").then(function (result) { installTavernInterfaceSkin(document, result && result.css || ""); });
    }
    function changed() {
        void applyActiveInterfaceSkin().catch(function () {});
        window.dispatchEvent(new CustomEvent(TAVERN_INTERFACE_SKIN_EVENT));
    }

    function InterfaceSkinSettings() {
        const h = React.createElement;
        const [index, setIndex] = React.useState(null), [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState("");
        const fileInput = React.useRef(null);
        React.useEffect(function () {
            let active = true;
            rpc("listInterfaceSkins").then(function (result) { if (active) setIndex(result); }, function (err) { if (active) setMessage("读取失败：" + err.message); });
            return function () { active = false; };
        }, []);
        async function run(method, args, notice) {
            setBusy(true); setMessage("");
            try { setIndex(await rpc(method, args)); changed(); setMessage(notice); }
            catch (err) { setMessage("失败：" + String(err && err.message || err)); }
            finally { setBusy(false); }
        }
        async function importFile(file) {
            if (!file) return;
            try { await run("importInterfaceSkin", { name: file.name, css: decodeTextResource(await file.arrayBuffer()) }, "已导入并启用"); }
            catch (err) { setMessage("导入失败：" + String(err && err.message || err)); }
        }
        const skins = index ? index.skins : [];
        const active = index && index.active || "";
        const disabled = !index || busy;
        const activeSkin = skins.find(function (item) { return item.id === active; });
        return h("section", { className: "dsh-tavern-settings-group" },
            h("div", { className: "dsh-tavern-settings-row" },
                h("span", { className: "dsh-tavern-settings-copy" },
                    h("strong", null, "界面皮肤"),
                    h("p", { className: "dsh-tavern-settings-desc" }, "导入 .css 皮肤文件更换酒馆的外观，可导入多套、在这里切换；选「默认」恢复原样。皮肤叠在「Theme / 外观」的配色之上，只改样式，不影响正文和存档。")),
                h("select", { "aria-label": "界面皮肤", disabled, value: active, onChange: function (event) { void run("selectInterfaceSkin", { id: event.target.value || null }, "已切换"); } },
                    h("option", { value: "" }, "默认"),
                    skins.map(function (skin) { return h("option", { key: skin.id, value: skin.id }, skin.name); }))),
            h("div", { className: "dsh-tavern-settings-row" },
                h("span", { className: "dsh-tavern-settings-desc" }, message),
                h("span", null,
                    activeSkin && !activeSkin.builtin ? h("button", { type: "button", className: "dsh-tavern-btn", disabled, onClick: function () {
                        if (window.confirm("删除皮肤「" + activeSkin.name + "」？")) void run("deleteInterfaceSkin", { id: active }, "已删除，恢复默认外观");
                    } }, "删除当前皮肤") : null,
                    h("button", { type: "button", className: "dsh-tavern-btn", disabled, onClick: function () { fileInput.current && fileInput.current.click(); } }, "导入皮肤…"),
                    h("input", { ref: fileInput, type: "file", accept: ".css,text/css", hidden: true, onChange: function (event) { const file = event.target.files && event.target.files[0]; event.target.value = ""; void importFile(file); } }))));
    }

    return { applyActiveInterfaceSkin, InterfaceSkinSettings };
}
