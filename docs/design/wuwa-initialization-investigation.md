# WuWa 完整初始化链路调查

核查日期：2026-09-10。分支：main。范围：点击人物卡、开场准备、原生会话、MVU 初值保存及卡片自检。本文记录现状，不代表整卡兼容已验证。

## 当前结论

真实会话的 journal 回放确认：12:10:37.208，`tavern-helper.messages` 在 revision 5981 将 `openingInitialization.status` 改成 `complete`，15 个开场变量均已保存。此前只看阶段性 snapshot 会漏掉后续写入；本次使用生产 `createChatJournalStore.read()` 回放。

同一个 loadId 的时间线（北京时间）：

| 阶段 | 时间 |
| --- | --- |
| 官方 MVU 下载开始 | 12:09:05.447 |
| 官方 MVU 执行完成 | 12:09:05.842 |
| subscriptions-ready | 12:09:06.009 |
| 伴随脚本 mouse 错误 | 12:09:06.435 |
| 宿主判断初值超时 | 12:09:21.916 |
| 全部开场变量保存 | 12:10:37.208 |
| 浏览器确认 initialization-ready | 12:10:37.548 |

约 92 秒后最终完成；15 秒提示失败不代表初始化任务已经停止。现有日志不能进一步证明 90 秒具体耗在哪一个 await，不能据此归因到某一个网络请求。

## 完整调用链

1. **选择卡片**：`src/client/main.js` 的 `preparePlayConversation` 调用 `getCardOpenings`，等待期间 UI busy。
2. **投影开场**：`lib/index.js:getCardOpenings` 读取卡片、扩展、预设正则，固定远程脚本依赖，调用 `projectCardOpeningPreviews`。本卡有 15 个开场、549 条世界书。全部开场 HTML 投影会放大返回体，需与脚本启动耗时区分。
3. **准备页运行时**：`lib/domain/opening-preparation.js:create` 建立内存 draft、世界书副本、单条带 15 个 swipe 的合成消息，并初始化 EJS 变量。此时还不是正式游戏的变量存档。
4. **进入游戏**：`lib/domain/conversation-initialization.js:initialize` 建立 Tavern Chat，设置 MVU pending，为全部开场分配空变量，发布 Chat，并经 `appendNativeOpening` 写入原生会话。准备页世界书可转入正式局；正式 MVU 变量仍需要初始化。
5. **宿主投影**：`projectTavernHelperContext` 提供消息、当前 swipe 变量、世界书、脚本变量与扩展设置。浏览器执行者加载共享脚本 iframe；多窗口执行权与 iframe 生命周期也是前置条件。
6. **脚本启动**：`main.js:buildTavernHelperScriptParts` 先加载宿主 jQuery/UI，再依次加载官方 MVU 和伴随脚本。模块完成指顶层执行完成，不保证其异步 ready 回调结束。官方 Mvu 全局可用后才继续伴随脚本。
7. **MVU 聊天初始化**：host-build 在官方 `main.ts` 中加入等待 `__dshTavernCompanionScriptsReady`，之后串行 `transitionToChat → initChatLevel → initCharacterSettingsOverride → initInitvar → initCheck`。
8. **读取初值**：`upstream/src/function/initvar/variable_init.ts` 读取已有变量、绑定世界书，解析 `[initvar]` 条目并合并，生成 schema。该条目即使 disabled 也会作为初始化输入，不应为了初始化把它打开。若世界书已初始化且无新增，`is_updated=false` 会直接返回。
9. **执行每个开场**：对 15 个 swipes 执行 `Promise.all`；各自处理开场 `<initvar>` 覆盖，然后等待 `VARIABLE_INITIALIZED` 监听器、`updateVariables`。全部完成后才调用一次 `setChatMessages({swipes_data})`。一个开场或监听器迟迟不返回，就会拖住这次批量保存。
10. **跨边界写入**：客户端 `setChatMessages → updateTavernHelperMessages` RPC，经 `lib/domain/tavern-script-host-adapter.js:updateMessages` 修改 Chat，检查所有开场有 `stat_data/schema`，写 journal 并置 complete，返回新 context。
11. **浏览器就绪**：`main.js:syncMvuDataReadiness` 依据 context 检查当前变量，清除错误并报告 initialization-ready。计时器超时只改变展示状态，没有取消上游初始化。
12. **卡片自身自检**：开场 HTML 独立检查 parent/global/DOM 标志。这不是 MVU 初值保存的确认，也不是宿主实际 EJS 能力的可靠替代。

## 已确认的负担与兼容边界

- 上述约 92 秒中有 654 次 Chat 写入：651 次提示词、2 次变量、1 次消息；610 次仅改变版本号和时间戳。卡片剧情逻辑每秒调用提示词同步；宿主 `withScript` 在回调结束后等待该脚本的 pending 提示词写入清空。无效写入是确定存在的负担，但尚未证明它独自造成全部等待。
- 一次核心 `subscriptions-ready` 不能表示所有伴随脚本及其异步初始化完成。当前诊断缺少每个伴随模块、每个 MVU 初始化 await 的耗时，导致超时提示不能定位卡点。
- 当前 `schema` 为字符串“没有用别管这个”。上游 `schema.ts` 明确将它视为 mvu_zod 兼容标记并转成 any，不能称为数据损坏。日志另有 expected object schema but got any；是否影响具体变量更新需要实际更新验证，不能把日志归属的 scriptId 直接认作报错代码来源。
- 卡片通过 `ST_WIN = window.parent` 后检查 `ST_WIN.SillyTavern...EjsTemplate.enabled`；宿主已有局部 facade 和 EJS readiness 投影，但直接 parent/top 属性重写不覆盖这种别名。自检的“未检测到”不能直接解释为 EJS 没实现。
- 世界书控制检查 DOM `#wb-float-monitor` 或全局 `SWITCHER_CONFIG`，仍需验证对象位于哪个文档，以及脚本是否完成；不能直接伪造标志消除红灯。
- 仍有 jquery-ui ESM 的 mouse 错误。宿主完整 UI 已加载不代表外部模块使用的是同一个 jQuery 实例。

## 后续验证优先级

1. 在单一执行者、隔离新局中记录 companion barrier、initCheck、逐 swipe 回调、prompt drain、最终保存的起止。预测：可区分模块未完成、回调/写入队列阻塞、批量开场放大三种原因。
2. 对相同提示词写入构造生产路径回归，验证去掉无效写入是否缩短初始化。不能仅提高超时阈值。
3. 分别验证 EJS 实际求值、世界书实际控制、一次 MVU 更新及刷新恢复；然后修正自检的访问边界。

本次只调查，未改变运行时代码、卡片内容和正式存档。未进行生成模型正文的验证。


## 已补充的验证与通用日志

本次已补上初始化计时，而非改变初始化策略：

- 通用 `initialization-timing` 经现有 MVU 诊断 RPC 写入日志，随“日志”ZIP 的 `mvu/diagnostics.json` 导出。记录伴随脚本整体等待和逐模块加载、世界书读取、初始化事件监听器、回调、提示词 drain，以及提示词/变量/消息写入。
- 按阶段和脚本 ID 聚合次数、失败数、总耗时、最大耗时、pending 数、最早 pending 等待时间。约每 5 秒采样，32 组上限，启动后最多 3 分钟；不保存脚本源码、RPC 参数、变量值。异步脚本身份的既有边界不因此消失。
- 更深层的官方 bundle await 计时仅在隔离测试启用：测试使用 AST 包裹初始化 await，保持原产物不变；正式环境没有重写官方 bundle。一般日志覆盖宿主边界，并不声称覆盖官方每一个内部 await。
- 补齐旧浏览器 smoke 的本地 runtime-assets 路由、真实世界书读取、提示词写入；增加临时目录的生产 Journal/ChatPersistence。测试数据与用户正式局隔离。

实测（暖资源缓存，真实卡片，隔离执行者；不是完整正式 UI 的端到端结果）：

| 用例 | 结果 |
| --- | --- |
| WuWa 15 个开场，生产 Journal | 最终一轮 4287ms；全部保存；0 次模型调用 |
| 刷新已初始化的隔离页 | 15 个开场变量仍完整 |
| 中性卡伴随脚本故意延迟 20 秒 | 20505ms 完成；5/10/15 秒日志可定位 slow-companion pending |
| 上述延迟卡套正常 15 秒门槛 | 断言失败，证明验证器能捕获慢初始化 |
| 延迟卡套预期延迟断言 | 通过；明确观察到 pending 后完成 |
| 相关 Node 测试 | 99 项通过 |

原运行环境的约 92 秒等待没有在隔离测试复现，仍未定位其根因。EJS、世界书控制的实际交互和 schema 整理报错没有因此判定修好。正式酒馆已重启加载通用计时，下一次复现可从导出日志定位宿主等待边界。

复跑方法（从仓库根目录运行；CARD_PATH 指向本机卡片 JSON，别把私人卡片提交进仓库）：

```sh
MVU_SMOKE_TRACE=1 MVU_SMOKE_JOURNAL=1 MVU_SMOKE_CARD_PATH="$CARD_PATH" node tests/browser/mvu-initialization-browser-smoke.mjs
```

在真实浏览器打开输出 URL 的 `?mode=opening-card`，等待初始化。然后执行：

```sh
node tests/fixtures/verify-mvu-initialization.mjs http://127.0.0.1:PORT opening-card-trusted
```

同服务打开 `?mode=opening-slow`，20 秒后：

```sh
node tests/fixtures/verify-mvu-initialization.mjs http://127.0.0.1:PORT opening-slow-trusted --expect-slow
```

去掉 `--expect-slow` 应触发 15 秒门槛失败。冷缓存联网耗时可能改变结果；测试使用的缓存状态必须随结果说明。验证器不会自动点击卡片或生成模型正文。


## 正式环境复现（新增计时后）

使用同一 Chrome 页面从“选择人物卡 → WuWa → 开始新游戏”创建测试局，未发送模型请求。新 Session `session-6d44e3c5-a188-44da-9111-dabc9e10dd35`，Chat `chat-mtv2ix5t-yor9d0`。

- 官方模块执行约 139ms；伴随脚本整体等待 816ms，说明本次瓶颈不在脚本模块下载/加载。
- 第 5 秒有 106 个提示词请求积压；15 个 prompt-drain 同时等待。
- 第 15 秒提示词积压 161 个，页面出现与用户截图相同的“初始变量尚未保存”；两个自检异常仍存在。
- 第 91.756 秒，提示词完成 219 个、积压 576 个；15 个 prompt-drain 已等待 89.321 秒，尚未出现 initialization-ready。
- 取样结束时的存储写入分布：`{"tavern-helper.prompts": 365, "opening.native-append": 1, "display.capture": 4, "tavern-helper.variables": 2}`；其中 319 次只更新时间戳和版本。

源码对应：`main.js` 的 Helper RPC 全部经 `record.rpcTail` 串行处理；`withScript` 在回调后执行 `drainPromptWrites(ownerId)`，循环等待该脚本整个 pending 集合清空。初始化并发处理 15 个开场，卡片还每秒继续同步提示词；新增请求超过处理速度，导致初始化等待不断延长。`tavern-script-host-adapter.js:updatePrompts` 对无变化操作也保存 Chat、返回 updated=true，客户端随后报告 mutation。

确认的直接阻塞是提示词队列持续积压和回调后的全队列 drain。尚未分别量化正式环境每次 RPC 的存储、视图失效刷新、通信成本，不能把所有耗时都归因于磁盘。脚本 ID 仍受既有异步身份归属边界影响，不据此把所有请求认作世界书控制脚本的源码行为。

停止方式：保留测试局和诊断日志，重启本地酒馆取消尚在运行的测试队列，避免继续产生无效写入。

修复应优先验证两点：相同提示词同步不产生存储/刷新副作用；初始化回调只等待自己的必要写入，不无限等待后来定时器追加的工作。不能只提高超时阈值或去掉所有写入等待。

## 2026-09-10：初始化排队修复与实机验证

本次在现有模块内修复，没有新增执行框架或拆分大模块：

- Host Adapter 在事务身份、脚本启用和生命周期校验后检查提示词实际变化。无变化不写 Chat、不报告更新。
- 回调返回后等待当时已经发出的提示词回执，不再循环追赶后续定时器写入。失败按回执保留，多个并发等待者都能观察失败；范围外的失败不会被提前消费。
- 同脚本、同事件、同生命周期内，相同的未完成注入/删除共享回执；操作触及相同 ID 时打断共享，一次性注入不共享。
- 实机验证证明仅以上两层优化仍不足：15 个开场也会产生不同内容的写入。宿主将尚未执行、相邻且身份一致的提示词请求按原顺序合为一批（最多 64 个）；读取、其他 RPC、身份变化分隔批次。整批先验证后保存，各调用者仍收到结果，只报告一次视图更新；执行时再次拒绝已结束事件。

最终正式新局 `session-5953ade5-de4a-4e3b-9038-487a3d837186` / `chat-mtv3b1qm-08nbxj`：从 MVU 下载开始到初始变量持久化约 4511ms；15 个开场全部保存 `stat_data` 和 `schema`，`openingInitialization.status=complete`。浏览器不再显示初始化失败。未发起模型生成。

验证：针对性 64 项通过；扩大范围 208 项中 203 项通过。剩余 5 项在未修改 HEAD 的隔离副本也复现：4 项模块加载 fixture，1 项后台工具列表断言。构建产物检查与 diff 空白检查通过。

范围限制：本次解决初始化等待饥饿和逐条 RPC 开销；没有宣称跨 await 的共享 script identity 已改为完整异步执行上下文。卡片仍出现“飞讯”脚本 `mouse` 错误，自检仍显示世界书控制/EJS 两项异常，这些兼容性问题没有在本次修复中被掩盖或标为通过。

刷新验证：初始化完成时间保持 `1789018310930`，没有重新执行开场初始化；15 组变量仍在。全变量哈希比较不相等，进一步对比 Journal revision 11 与 14，唯一变量差异是第 0 个开场的 `stat_data.插图系统`（配套脚本刷新写入），不能表述为“刷新后所有字段完全不变”。

## 2026-09-10：配套浮窗修复

独立原卡浏览器复现定位到 `jquery-ui/ui/widgets/draggable/+esm` 缺少 `ui.mouse`。此导入由世界书控制脚本触发；运行错误记录中的“飞讯”归属并不可靠。原因是可信脚本仍使用 iframe 自己的 jQuery，而完整 jQuery UI 只装在宿主。

可信脚本在宿主 jQuery/UI 就绪后使用宿主实例，恢复原卡 `$('body')` 浮窗语义；隔离模式不跨文档。真实浏览器中 `#wb-float-monitor`、`#fx-global-status` 均出现在宿主页面，新增 `mouse` 错误消失，世界书浮窗从 (20,80) 拖至约 (222,173)。66 项消息渲染测试通过。原卡仍有 `cleanupResidualAutoBlue` 引用未声明 `roundWb` 的独立错误，尚未在此提交中修改。

## 2026-09-10：可信宿主接口与 EJS 自检

EJS 后端已有实际运行时就绪状态，缺口在原卡从 `window.parent.SillyTavern.getContext()` 检测，而接口仅存在于脚本 iframe。可信模式现将当前脚本接口转发到宿主，状态仍来自正式 Helper context；隔离模式不开放。卸载时恢复原接口，交叠的旧实例不会清除新实例，也不会恢复已退出的 iframe。

真实 DSH 页面中九项自检显示“全部就绪”，世界书监控浮窗可见。针对消息渲染、生命周期、Helper API、兼容模块、EJS 和扩展状态的 134 项测试通过；包括实际就绪状态变化和交叠卸载回归。尚未验证模型生成后的完整剧情流程。

## 2026-09-10：原卡世界书清理函数

本地 `data/resources/cards/鸣潮.json` 的世界书控制脚本在 `cleanupResidualAutoBlue` 中引用未声明的 `roundWb`。将主循环已有的批次缓冲参数传入该函数，保留手动蓝灯条目和独立调用时直接保存的行为。修复只作用于本地卡，不通过全局变量兼容层掩盖，也没有把原卡内容收录进仓库。

原卡备份：`~/.dsh/profile-data/tavern/data/recovery/cards/鸣潮-before-worldbook-round-fix-20260910-164353.json`。

回归工具 `node tests/fixtures/verify-wuwa-worldbook-script.mjs <card.json>` 读取外部卡，提取清理函数并使用一次性数据验证。修改前复现 `ReferenceError: roundWb is not defined`，修改后缓冲写入、手动条目保留和独立保存均通过。其他用户仍需取得修复后的卡；该本地修改不会随插件更新自动分发。
