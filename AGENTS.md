# DSH Tavern

## 提交

每完成一个比较大的功能点或修复，立即单独提交一次；提交只包含该功能点或修复，避免混入无关改动。如果只是很琐碎的改动，比如调整一下文本、按钮位置，则不必自动提交。

## 文档

本地写的 docs（研究记录、实验笔记、临时调研）**不提交、不推送**，只留在工作区或仓库外。有价值的结论写进提交说明或已有的功能文档，不要新增 docs 文件入库。

## 推送

## 分支

- `main`：只用于同步上游，保持 fork sync 可用；不提交或推送自有修复。
- `trunkbase`：本 fork 的修复维护与制品来源分支，日常修改和推送都在这里。
- `stable`：上游旧宿主兼容线已停止更新，不作为本 fork 当前实例的维护入口。

推送自有修复时：

1. 确认当前分支为 `trunkbase`，相关检查已通过。
2. `git fetch origin`，检查 `origin/trunkbase` 是否有新增提交；有变动先审阅，不强推覆盖。
3. `git push origin trunkbase`，回读远端提交号。不得把当前修复推送到 `main`。

同步上游时先更新 `main`，再在 `trunkbase` 审阅并整合变化，复核自有修复是否已被上游覆盖。不要重新盲目移植整包旧补丁。

Tavern 插件包可以本地构建；CI 是可选的自动检查/发布设施。当前工作流暂停，未经用户要求不重新启用。制品交付记录固定源码提交及 SHA-256，不复制开发机的 `node_modules` 到目标机器。

### CDN 缓存

安装入口从 jsDelivr 的 `@main` / `@stable` 读取 `install.ps1` / `install.sh` / `dsh-tavern-runtime.json`（最长缓存 12 小时），代码文件却按清单里的提交号下载；旧安装脚本配新代码会报“安装文件不完整，缺少……”。

以下为上游 `main` / `stable` 安装器的发布行为，不适用于本 fork 的 `trunkbase` 本地打包流程：Publish runtime manifest 工作流会在发布新清单后自动刷新这三个文件的缓存，并等到 CDN 返回新清单。工作流出现 “jsDelivr still serves a stale manifest” 警告时，手动刷新：

```sh
b=main  # 或 stable
for f in install.ps1 install.sh dsh-tavern-runtime.json; do curl -s "https://purge.jsdelivr.net/gh/flizzywine/dsh-tavern@$b/$f" >/dev/null; done
curl -s https://cdn.jsdelivr.net/gh/flizzywine/dsh-tavern@$b/dsh-tavern-runtime.json | grep revision
```

## 测试

静态检查对新增或修改的 JS/MJS 执行 `node --check`；本仓库沿用各文件原有格式，未配置统一格式化器，以 `git diff --check` 检查变更格式，避免整库重排。客户端、插件清单和文档生成物分别运行对应构建脚本与 `--check`。功能变更补充单元测试及真实格式或真实宿主的集成回归；浏览器测试必须实际启动浏览器，跳过或替身不算浏览器验收。

测试已有几千条，全量跑一次约 3 分钟。除非做版本发布，否则不要跑全量 `node bin/test-tavern.mjs`；只跑与改动相关的测试文件：
`node bin/test-tavern.mjs tests/<相关>.test.mjs [更多文件…]`
