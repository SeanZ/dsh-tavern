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
        // Same look as the other rows of 「Theme / 外观」 (dream-skin's group/title/button styles).
        const control = { height: "32px", padding: "0 14px", borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-button-elevated-fill)", color: "var(--dsw-alias-label-primary)", cursor: "pointer", font: "inherit" };
        return h("div", { style: { borderBottom: "1px solid var(--dsw-alias-border-l2)", display: "flex", flexDirection: "column", gap: "10px", padding: "16px 0" } },
            h("div", { style: { color: "var(--dsw-alias-label-primary)", fontSize: "14px", lineHeight: "22px" } }, "皮肤"),
            h("div", { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" } },
                h("select", { "aria-label": "皮肤", disabled, value: active, style: Object.assign({}, control, { padding: "0 10px", minWidth: "160px" }), onChange: function (event) { void run("selectInterfaceSkin", { id: event.target.value || null }, "已切换"); } },
                    h("option", { value: "" }, "默认"),
                    skins.map(function (skin) { return h("option", { key: skin.id, value: skin.id }, skin.name); })),
                h("button", { type: "button", style: control, disabled, onClick: function () { fileInput.current && fileInput.current.click(); } }, "导入皮肤…"),
                activeSkin && !activeSkin.builtin ? h("button", { type: "button", style: control, disabled, onClick: function () {
                    if (window.confirm("删除皮肤「" + activeSkin.name + "」？")) void run("deleteInterfaceSkin", { id: active }, "已删除，恢复默认外观");
                } }, "删除") : null,
                h("input", { ref: fileInput, type: "file", accept: ".css,text/css", hidden: true, onChange: function (event) { const file = event.target.files && event.target.files[0]; event.target.value = ""; void importFile(file); } })),
            h("div", { role: "status", style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "18px" } },
                message || "改变酒馆的排版、字体和形状，叠在上面的配色之上。导入 .css 皮肤文件后可在这里切换，选「默认」恢复原样；不影响正文和存档。"));
    }

    return { applyActiveInterfaceSkin, InterfaceSkinSettings };
}
