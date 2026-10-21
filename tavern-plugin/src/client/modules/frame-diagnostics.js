// 人物卡消息 frame 的诊断登记处。诊断只归属当前前台会话：后台保留的 frame 不写运行报告，
// 显式 DOM 快照也只向前台会话的 frame 索取。frame 重建或注销时由生命周期释放登记与等待。
// eslint-disable-next-line no-unused-vars -- 由客户端拼接入口及 frame 脚本调用。
const TAVERN_FRAME_SNAPSHOT_TIMEOUT_MS = 2000;
// eslint-disable-next-line no-unused-vars -- 由客户端拼接入口及 frame 脚本调用。
function createTavernFrameDiagnostics(host) {
    const entries = new Set();
    function foreground(sessionId) {
        const selected = String((host && host.__dshTavernSelectedSessionId) || "");
        return Boolean(sessionId) && (!selected || selected === String(sessionId));
    }
    return Object.freeze({
        foreground: foreground,
        register: function (entry) {
            entries.add(entry);
            return function () {
                entries.delete(entry);
            };
        },
        // 导出日志前调用：等待前台会话各 frame 的快照写入；单个 frame 超时只算未采集，不阻塞导出。
        capture: function (sessionId) {
            if (!foreground(sessionId)) return Promise.resolve(0);
            const pending = Array.from(entries)
                .filter(function (entry) {
                    return String(entry.sessionId()) === String(sessionId);
                })
                .map(function (entry) {
                    return Promise.resolve(entry.snapshot()).catch(function () {
                        return false;
                    });
                });
            return Promise.all(pending).then(function (results) {
                return results.filter(Boolean).length;
            });
        },
        size: function () {
            return entries.size;
        },
    });
}
