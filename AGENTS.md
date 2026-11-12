# DSH Tavern

禁止在正常回答后，习惯性追加“不能证明、不能认定、不代表、不等于、不足以判断、不能保证”等否定式限定。

禁止主动设想用户没有提出的推论，再逐一否定。禁止用这类限制、转折和免责声明代替对当前问题的直接回答。

同一处不确定性只说明一次；禁止在每个判断、来源或建议后重复补充“但这不能说明……”之类的声明。必要的未知、条件和风险直接说清，不省略、不反复铺陈。

## Issue 处理

- 查看 issue 时，遇到原因明确、能直接修复的小问题，直接修复并完成后续流程，无需另行征求意见；需求不清楚或涉及较大取舍时再向用户确认。
- 处理流程：定位并修复 → 跑相关测试 → 单独提交 → 按下文流程推送 → 在 issue 评论修复内容、提交和验证结果 → 关闭已解决的 issue。问题仍未解决时保留开启并说明阻碍。

## PR 处理

- 用户要求查看或审查 PR 时，审查无问题、相关测试和必需检查通过且可正常合并后，直接合并到目标分支，无需再次确认；有未解决的问题则说明并保留 PR。

## 提交

**任务完成必须提交**：无论改动大小，任务或修复一旦达成可验收的结果，立即 `git commit`，不得把改动留在工作树里等用户提醒；每个提交只包含该功能点或修复，避免混入无关改动。琐碎改动（例如文案、按钮位置微调）可以并入相关提交，没有相关提交时单独提交一次。只有用户明确要求不提交时才跳过。

采纳他人提出的具体代码修改时，即使建议来自 issue 而非 PR，也可以在对应提交中通过 `Co-authored-by: 姓名 <邮箱>` 将提议者列为共同作者。署名使用可核实的作者信息（包括 GitHub noreply 邮箱）。

## 文档

本地写的 docs（研究记录、实验笔记、临时调研）**不提交、不推送**，只留在工作区或仓库外。有价值的结论写进提交说明或已有的功能文档，不要新增 docs 文件入库。

## 推送

用户说「推送」/「push」/「推一下」时，**默认就是 `origin` = `https://github.com/flizzywine/dsh-tavern.git`**，不必再确认远程。只有用户明确点名别的远程（例如「推到 fork」「推 bigmalove」）才换目标。

仓库里同时存在 `fork` = `https://github.com/bigmalove/dsh-tavern`，那是另一条血统（与本地 `main` 分叉数百个补丁不等价的提交）。**没有明确要求时不对它 rebase、不强推**；真要同步只能 `git merge fork/main`，或经用户明确同意后强推。

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

main 的安装入口和备用更新清单从 jsDelivr 的 `@runtime-archive-main` 读取；该分发分支只放安装脚本、清单和 `runtime.zip`，源码仍在 main。清单固定引用不可变提交中的压缩包。分支地址最长缓存 12 小时，安装入口与清单必须来自同一次发布。

以下为上游 `main` / `stable` 安装器的发布行为，不适用于本 fork 的 `trunkbase` 本地打包流程：Publish runtime manifest 工作流会在发布新清单后自动刷新这三个文件的缓存，并等到 CDN 返回新清单。工作流出现 “jsDelivr still serves a stale manifest” 警告时，手动刷新：

```sh
b=runtime-archive-main
for f in install.ps1 install.sh android/setup.sh dsh-tavern-runtime.json; do curl -s "https://purge.jsdelivr.net/gh/flizzywine/dsh-tavern@$b/$f" >/dev/null; done
curl -s https://cdn.jsdelivr.net/gh/flizzywine/dsh-tavern@$b/dsh-tavern-runtime.json | grep revision
```

### CDN 体积注意事项

- 每次构建 CDN 缓存包（包括 `runtime.zip` 和 NEXT 的 `.tgz`）都要检查成品字节数。**单个包必须小于 20,000,000 字节（20 MB）**，分发树必须小于 50,000,000 字节。jsDelivr 会拒绝超限文件；超限时先精简内容，再重新打包并验证 CDN 能下载。
- `.gitattributes` 的 `export-ignore` 控制 Git 归档，运行清单的排除规则控制安装内容；两者都不能直接视为 jsDelivr 的缓存排除配置，须实际验证 CDN 能返回目标文件和最新清单。
- 打包时始终检查重复的构建产物，优先排除冗余副本、测试、文档、构建专用源码和已支持按需下载的字体二进制；保留许可证、共享运行模块和 vendor 运行构建，排除前核对运行时引用及旧安装器兼容性。
- `runtime-archive-*` 只发布安装入口、清单和 `runtime.zip`，发布前验证安装脚本与压缩包的字节数、SHA-256 均匹配清单。修改入口时同步检查安装脚本、应用内更新和缓存刷新流程；旧版仍读取 `@main` 时可通过新版安装脚本迁移，刷新旧地址不能解决源码分支超限。

## 测试

静态检查对新增或修改的 JS/MJS 执行 `node --check`；本仓库沿用各文件原有格式，未配置统一格式化器，以 `git diff --check` 检查变更格式，避免整库重排。客户端、插件清单和文档生成物分别运行对应构建脚本与 `--check`。功能变更补充单元测试及真实格式或真实宿主的集成回归；浏览器测试必须实际启动浏览器，跳过或替身不算浏览器验收。

测试已有几千条，全量跑一次约 3 分钟。除非做版本发布，否则不要跑全量 `node bin/test-tavern.mjs`；只跑与改动相关的测试文件：
`node bin/test-tavern.mjs tests/<相关>.test.mjs [更多文件…]`
