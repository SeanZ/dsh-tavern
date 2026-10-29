# dsh-free-search-fork-for-dsht 源码研究

日期：2026-10-25。查阅 main：77cb72717ce0d877e124973f57a66e8e395185e3；package version 0.9.2。本记录为静态源码审阅，未安装插件或验证公网源在用户网络下可达性。

## 可吸收的核心

1. **保留单一 web_search，替换 provider**。插件使用 ctx.web.registerSearchProvider(provider)，适配 0.2.1 的 settings ref provider 选择；因此无需向模型暴露每个搜索引擎为单独工具。[index.js:4195-4260](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/lib/index.js#L4195)
2. **搜索可靠性**：按 quota/auth/bot-wall/transient 等分类错误；quota/auth 进程级无限期冷却，bot-wall/限流 60 秒；暂时错误重试但限流不立即重试；支持自定义 fallbackOn。可移植思路，但应明确恢复入口和配置变动后的冷却重置。[index.js:98-170](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/lib/index.js#L98)、[index.js:4118-4148](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/lib/index.js#L4118)
3. **SearXNG 可配置实例、后端引擎与 token**；每实例 8 秒，顺序 failover，空结果也转下一个；显式后端引擎能避开某实例的坏默认。默认实际只有 search.mectov.my.id，不能把 20261017 的测试变成今天国内可用的保证。[index.js:750-824](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/lib/index.js#L750)、[默认配置](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/lib/index.js#L3300)
4. **合并结果**：URL 去追踪参数与归一化；多源排序按域名分组交错，而不是把多引擎收录当作独立证据。适合角色资料检索。域名后缀表非完整 PSL，不能当完整域名归属分析。[url_norm.js](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/lib/url_norm.js)、[multi_policy.js](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/lib/multi_policy.js)
5. **原文证据包**：research 输出 url/title、body vs snippet-only、fetched_at、updated_at、cache、truncated；正文选窗后保留原文顺序；抓不到时明确仅摘要，不伪称读过全文。这一结果契约最适合工作台吸收。[research.js:804-818](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/lib/research.js#L804)、[research.js:1098-1163](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/lib/research.js#L1098)、[research.js:1325-1356](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/lib/research.js#L1325)
6. **缓存**：查询结果内存 LRU 50 条、TTL 最长 5 分钟，失败回退结果 TTL 缩短。research 正文 node:sqlite 保存 URL/title/content/fetched_at，七日可用，cache_search 用 LIKE 而非真正 FTS；Node 缺 sqlite 时 no-op。它是资料缓存，不是卡片长期知识库，不能照搬当作品资料归档。[index.js:3773-3805](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/lib/index.js#L3773)、[index.js:4092-4105](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/lib/index.js#L4092)、[cache.js](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/lib/cache.js)

## 不宜直接照搬

- **整套工具与配置过大**：26 个引擎名（README/package 描述还写24），index.js 5513行、client.js约155KB、research.js1403行；天气、视频、编程包/金融领域检索不是角色工作台核心。建议第一期只做 search + fetch，第二期作品资料证据包。
- **默认代理并非全直连**：ddg/ddg-lite 与 platform_search/domain_search/research 默认 localhost:10808。web_fetch provider 实际读取 research 代理。内置应默认空代理，用户选择后启用。[index.js:3321-3324](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/lib/index.js#L3321)、[fetch_provider.js:240](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/lib/fetch_provider.js#L240)
- **抓取内存与正文质量**：httpsGetFollow 整个解压响应直接累积到 chunks，没有字节上限；T1 仅 HTTP成功 + 文本类型 + 300字符判定，不足以排除登录页/挑战页；HTML直接返回而非正文提取。[fetch_provider.js:147-180](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/lib/fetch_provider.js#L147)、[fetch_provider.js:226-246](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/lib/fetch_provider.js#L226)
- **浏览器自动升级成本**：失败后自动启动系统浏览器，带 --no-sandbox，最长60秒；Linux候选是命令名但 findSystemBrowser 用 existsSync，没有实际 PATH解析。内置基础抓取不应直接继承此行为。[fetch_provider.js:21-78](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/lib/fetch_provider.js#L21)、[fetch_provider.js:248-263](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/lib/fetch_provider.js#L248)
- **预算、取消与重复回退**：research 把一次 provider.search(engine:multi)计作一个 search 请求，却声称包含全部后端请求；fetchTiered 把 ctx.web.fetch 算一回，而该 provider 自身已含 direct/browser/exa/firecrawl/crawl4ai 链，之后 research 又可重复 exa/firecrawl/crawl4ai。部分费用和真实网络尝试不纳入外层预算。fetch_provider 的 Firecrawl/Crawl4AI 还传 undefined signal。因此90秒预算不能仅凭注释认为全链可强制中止。[research.js:97-109](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/lib/research.js#L97)、[research.js:715-789](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/lib/research.js#L715)、[research.js:922-925](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/lib/research.js#L922)、[fetch_provider.js:267-290](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/lib/fetch_provider.js#L267)
- **研究模型依赖**：rerank/embed 使用 SiliconFlow；decision 模型帮助意图判断与补搜；失败有规则回退。可移植选窗和证据格式，暂不内置整套外部模型调用。[rerank.js](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/lib/rerank.js)
- **测试不可复现**：当前完整 git tree 没有 tests/ 或 scripts/；package.json 的 check 指向缺失 scripts/check-consistency.mjs。源码包含 controlled stubs 不等于仓库有可跑测试。不能宣称该 fork 已通过跨平台测试。[package.json](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/package.json)、[完整树](https://api.github.com/repos/ActivityTime/dsh-free-search-fork-for-dsht/git/trees/77cb72717ce0d877e124973f57a66e8e395185e3?recursive=1)

## 许可证

MIT，copyright 2026 dsh-free-search contributors；复制实质代码需要保留版权和许可文本。[LICENSE](https://github.com/ActivityTime/dsh-free-search-fork-for-dsht/blob/77cb72717ce0d877e124973f57a66e8e395185e3/LICENSE)

## 建议落地

主代理本地核对补充：DSHT 的 foreground-orchestration-strategies.js:440、467-484 已有插件工具的 disabledForegroundTools 过滤，不应采信 fork 注释声称所有插件单工具门禁缺失。缺口是统一联网能力分组与会话策略，而非重做整套开关。宿主后台现有 web_search 可跟随 provider，无需给后台额外暴露该插件全部工具。存储应通过 DSHT 所有者接口获取会话和模式，不移植插件自解析 DSHT 存储布局的兼容代码。

第一期：统一会话联网策略；复用现有 web_search provider 接口；少数可配置免费源 + 故障回退；可选 web_fetch（正文提取、字节/字符上限、总超时、取消）；代理默认为空。
第二期：卡片工作台“补充作品资料”，输出可引用的原文证据包和短期缓存，模型根据来源生成卡片内容。复用格式/纯函数而不是直接移植 research 的重复网络编排。

