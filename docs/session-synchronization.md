# 客户端会话同步：所有权、重试与生命周期

本次对应 [Issue #135](https://github.com/flizzywine/dsh-tavern/issues/135)。范围是客户端已确认的竞态和退出清理，不更换 DSH、服务端协议或增量视图格式。

## 方案选择

采用局部重构：`session-refresh-controller.js` 统一 Live View 和协调状态的异步读取所有权、超时、单次在途读取及重试调度。组件仍使用现有不可变快照和按字段订阅，消息历史不新增扫描。

逐个补 `if` 容易遗漏错误、hydration、退出重入和 watchdog 的同类路径；引入服务端全局 revision/有序推送协议则涉及另一层兼容性和迁移。本次选择前者的根因边界，不扩大为全栈协议重写。

## 必须成立的不变量

1. 每个会话的每个状态投影只有一个可发布结果的读取流水线（Live View 与协调状态分别持有 owner）。通知只是唤醒，合并成一次后续读取，不因每个通知取消正在取得的有效结果。
2. HTTP、后续历史 hydration 和它们的失败共用同一任务所有权。接受直接替换或信号快照时，先撤销旧所有权，再取消旧请求；旧成功、错误、超时和 `finally` 均不能改变继任任务。
3. 取消/退订/重进会话创建新的生命周期。旧任务即使忽略 AbortSignal 也不能写入；取消中的 RPC 立即释放 reader 所有权，并保留标准 AbortError，兼容候选任务现有重试逻辑。
4. 重试具有固定的最早执行时间。排队通知、后续通知及 watchdog 均不得提前或不断推迟这个时间。终止错误清除失败之前积压的通知。
5. HTTP 和 hydration 都有截止时间，卡住的 hydration 不能永远阻塞已排队的权威读取。
6. Reader 的最新成功序号和结果由在途请求共享的会话 owner 保存。LRU 只淘汰缓存；有请求未结束时，淘汰或 A→B→A 不能抹掉其新旧关系。旧成功/旧失败只在存在严格更新的已接受结果时回送最新完整快照，不混用旧 cursor、delta 或变更路径。
7. 最后一个信号订阅退出后，连接、缓存和重试定时器均释放。每次会话集合变化创建新 stream owner，旧 stream 的所有回调及异步 dispose 完成均不能影响新 stream。
8. 初次订阅及重连后仍读取 HTTP 基线，包括 Remote 同步重放缓存快照的情况。普通无快照通知仍会触发查询。

每次请求、通知或替换只增加常数级所有权检查。已有 indexed-array、receipt 索引和字段依赖路由保留；20、400、10000 楼层的现有成本断言一并回归。

## 独立边界与限制

- iframe 内部 HTML 根节点消失时，测高和 observer 注册跳过空根；根恢复后下一次有效激活重新注册并恢复测量。不增加常驻 document observer 或轮询。
- `turnMessageIds` 的既有楼层 turn/role 变化问题需要调用方错误地给出 `layoutChanged=false`。两个生产存储入口均将这些变更标记为布局变化；未证实普通路径可达，因此本次不扩大修改映射算法。
- 信号版本是复合字符串，不能作为全局递增版本比较。本次保证客户端在途请求和生命周期的所有权，不保证任意两份服务端快照的全局时间顺序。
- 这不是“所有卡顿已解决”的结论。真实浏览器布局、真实模型调用、原始 Windows/手机延迟场景仍需实机复核。DOM/故障注入测试和真实 Gateway 类集成测试不能代替它们。

## 定向验证

遵循 AGENTS.md，只运行相关文件，不运行发布全量套件。先准备项目锁定依赖和 DSH 0.1.5-rc.2；必要时将 `DSH_BOOT_MODULE` 指向该版本 `dsh-app-boot/lib/index.js`。

```sh
node bin/build-tavern-client.mjs --check
node bin/build-plugin-package.mjs --check
node bin/test-tavern.mjs \
  tests/session-refresh-controller.test.mjs \
  tests/session-view-sync.test.mjs \
  tests/session-sync-races.test.mjs \
  tests/session-rpc-freshness.test.mjs \
  tests/request-performance-client.test.mjs \
  tests/live-tavern-view.test.mjs \
  tests/frame-root-removal.test.mjs \
  tests/tavern-remote-transport.test.mjs \
  tests/tavern-remote-gateway-lifecycle.test.mjs \
  tests/tavern-remote-assets.test.mjs \
  tests/tavern-coordination-event.test.mjs \
  tests/coordination-event-stream.test.mjs \
  tests/coordination-event-publisher.test.mjs \
  tests/session-signal-transport.test.mjs \
  tests/empty-view-refresh-cost.test.mjs \
  tests/turn-field-merge-cost.test.mjs \
  tests/scoped-view-refresh-cost.test.mjs \
  tests/regeneration-mapping-sync.test.mjs \
  tests/receipt-keyed-sync.test.mjs \
  tests/receipt-point-update.test.mjs \
  tests/receipt-render-lookup.test.mjs \
  tests/projection-render-cost.test.mjs \
  tests/view-delta.test.mjs \
  tests/card-runtime-lifecycle.test.mjs
```

Remote 客户端另外使用锁定的 TypeScript 6.0.3 / tsdown 0.22.14 编译和生成；保留源码与生成 bundle 的同一组 transport 行为测试。

`tests/tavern-remote-gateway-lifecycle.test.mjs` 通过 Remote 包的普通模块解析加载真实 Gateway 类；设置 `DSH_BOOT_MODULE` 后也测试运行时版本。缺少依赖时会明确 skip，不把它算作已验证。只模拟远端异步数据源和时间，不模拟 RemoteStream/RemoteSnapshotStream 本身。

2026-10-04 本地验证：上述 24 个相关测试文件在 Linux、Node 22.19.0 和 Node 24.19.0 下分别通过 213 项，失败 0、跳过 0；运行器加载锁定的 DSH 0.1.5-rc.2。客户端生成一致性、插件包一致性、JavaScript 语法和 diff whitespace 检查通过。Remote TypeScript 编译通过，重复生成结果字节一致。真实 Gateway 的 8 个用例在原始 bundle 上全部失败，在本次 bundle 上全部通过；4 个根节点移除用例在恢复原始实现后全部失败。

这里的“加载 DSH”表示通过项目测试运行器/预加载器验证依赖组合，不表示完整应用启动、真实浏览器或真实模型端到端测试已经通过。
