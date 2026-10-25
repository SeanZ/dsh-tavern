# 安装、更新与数据备份

> 当前版本适配 DSH **0.2.x**（0.2.0-rc.2 起；官方 DeepSeek Harness 推荐 0.2.1-rc.2 或更新，独立命令行固定 0.2.1-rc.2）。Android 独立 APK 内置 DSH **0.2.0-rc.2**。Windows 一键安装版和 DSHA 0.1.5-rc2 说明属于[稳定版](https://github.com/flizzywine/dsh-tavern/blob/stable/docs/installation.md)（DSH 0.1.5，`stable` 分支）。

**桌面版仅支持官方 DeepSeek Harness，不再适配社区 DSH Desktop / DSH NEXT。** 社区版用户请先备份，再按[数据导入说明](data-import.md)迁移到官方版。

## Android 独立 APK（Android 11+ / ARM64）

[下载 DSH Tavern Android APK](https://github.com/flizzywine/dsh-tavern/releases/latest/download/dsh-tavern-android-release.apk) · [下载 SHA-256 校验文件](https://github.com/flizzywine/dsh-tavern/releases/latest/download/dsh-tavern-android-release.apk.sha256)

1. 下载 APK，按 Android 提示允许当前浏览器或文件管理器安装应用，然后安装。
2. 打开「DSH Tavern」，按首次引导完成内置环境部署（离线解压，不需联网）；随后会解包内置的酒馆与依赖并自动完成安装，无需另装 DSHA，也无需输入命令。
3. 安装完成后会自动进入酒馆；在酒馆设置中配置文字模型，再导入人物卡。
4. 以后直接打开此应用；酒馆源码更新在应用内完成，更新后返回启动页重启。

独立 APK 只运行酒馆自己的 `tavern` Profile（端口 3080），手机上只运行这一个 DSH 服务。

这是在线安装包，首次启动需要下载最新版酒馆；请保持应用运行。依赖下载失败时，应用会自动改用官方 npm 源（registry.npmjs.org）重试一次。仍失败时保留错误日志，再点击启动重试；安装日志位于容器内 /root/.dsh/logs/tavern-install.log。

APK 使用独立包名 `io.github.flizzywine.dshtavern.standalone`，可以与旧版 v2.1 APK 和原版 DSHA 同时安装，数据各自独立。旧版 v2.1 APK 与本包签名不同，不能覆盖升级：先在旧包里导出存档和人物卡，装好本包后按[数据导入](data-import.md)导入。两个应用不要同时运行。Android 安装包不从应用内自更新；新版本从 [Releases](https://github.com/flizzywine/dsh-tavern/releases) 下载覆盖安装，不要先卸载。

Android 仅提供独立 APK，要求 Android 11 及以上、ARM64；不再提供通过 DSHA 安装的方式。

[返回项目首页](../README.md) · [在线使用文档](https://flizzywine.github.io/dsh-tavern/)

Windows Desktop 安装和更新使用 Desktop 自带的 pnpm 与 Node（即 Desktop 程序本身），不再另外下载 Node；旧版留下的 `tools/desktop-package-manager` 目录不再使用，可以删除。安装器会自动使用 Windows 系统代理（PAC 自动配置除外）。若旧版一直卡在“正在更新”，先关闭旧更新任务，再使用新版安装器修复入口；普通 Desktop 从系统终端重新运行本文安装命令。命令行版继续使用独立 Node，macOS/Linux 不应用这项 Windows 修复。

Desktop 需为 **0.2.x**（0.2.0-rc.2 起）；以后在酒馆界面更新插件。仅 Desktop 安装和更新内置 **`dsh-pocket 2.12.0`**（固定版本），并移除冲突的 `dsh-web-mobile`；手机扫码入口在 **设置 → 手机访问**，无需自行安装插件。CLI 不安装 Pocket，升级时会移除旧版 Pocket。Android / DSHA 不安装 Pocket，继续使用 `dsh-web-mobile`。切换到下面的 CLI 安装方式不会自动同步这份数据。

### 命令行及宿主内安装

CLI 首次安装可选择：**默认目录 `~/.dsh-tavern/`、当前目录（回车默认）、其他完整路径**。下文默认路径均可替换为所选目录。程序放在其 `apps/dsh-tavern/` 下，运行时和数据分别存放；命令入口及包管理器缓存可能位于目录外。

设置 `DSH_TAVERN_CLI_HOME` 时直接使用指定位置；无交互终端时必须设置。更新沿用已安装位置，重新安装请在原安装根目录运行或指定该变量。已有安装失败后也可在原位置重试。

按使用环境选择安装方式：

| 安装方式 | DSH 运行时与版本策略 | 数据位置 |
| --- | --- | --- |
| 命令行版（Windows / macOS / Linux） | 使用独立的 DSH `0.2.1-rc.2`；版本匹配且可启动时直接复用，不要求预装 DSH，不复用或替换全局 DSH | 默认 `~/.dsh-tavern/`，与外部 DSH 数据分开 |
| 官方 DeepSeek Harness | 推荐 **0.2.1-rc.2** 或更新的 0.2.x，复用宿主自带 DSH；内置 DSH 在 0.2.0-rc.2 ≤ 版本 < 0.3.0 范围内即可，已知不兼容的版本会被拦截 | Desktop 的 Tavern Profile 数据目录 |
| 独立 APK（Android） | 内置 DSHA v0.2.0-rc2 与 DSH `0.2.0-rc.2`，只运行 `tavern` Profile，手机上只有一个 DSH 服务 | APK 自己的应用数据目录 |

命令行版与 Desktop / DSHA 不再共用一套数据。切换安装方式不会自动同步人物卡或对话；首次升级旧 CLI 时会复制旧 CLI 配置和游戏数据，保留原件，Desktop / DSHA 数据不会自动迁入。

官方桌面版安装器会检查宿主内置的 DSH 版本：与适配版本不一致时停止安装，并提示适配宿主版本；不会自动升级或降级宿主。若缺少必需依赖或接口，会明确报错。如遇兼容问题，请自行下载适配版本：[DSH 下载页面](https://www.deepseek.com/harness/)。

**首次安装、更新或重新安装，都运行下面对应的同一条命令。** 已安装时会覆盖更新程序文件，保留人物卡、对话、配置、自定义工具和 Skill，无需先卸载。重新安装前建议备份数据；如果使用了自定义数据或安装目录，请保持原配置。

### 官方 DeepSeek Harness 桌面版

适合不想单独配置运行环境和管理服务的用户，支持 Windows 和 macOS。

推荐 **官方 DeepSeek Harness 0.2.1-rc.2** 或更新的 0.2.x，内置 DSH 不在支持范围（0.2.0-rc.2 ≤ 版本 < 0.3.0）或属于已知不兼容版本时停止安装。请自行打开 [DSH 下载页面](https://www.deepseek.com/harness/)，按页面提示下载适合自己 Windows / macOS 系统和处理器的安装包；不要下载 Source code。

安装后先退出官方桌面应用，在系统终端运行对应命令。Windows 使用 PowerShell，macOS 使用终端。安装器自动查找默认安装位置；自定义位置请设置 `DSH_DESKTOP_APP_EXECUTABLE` 为官方程序的完整路径。无需另装 Node 或 pnpm。

Windows：

```powershell
$env:DSH_TAVERN_HOST='desktop'; $tavernInstaller=[Text.Encoding]::UTF8.GetString((New-Object Net.WebClient).DownloadData('https://raw.githubusercontent.com/flizzywine/dsh-tavern/main/install.ps1')); Invoke-Expression $tavernInstaller
```

macOS：

```bash
curl -fsSL 'https://raw.githubusercontent.com/flizzywine/dsh-tavern/main/install.sh' -o /tmp/dsh-tavern-install.sh && DSH_TAVERN_HOST=desktop sh /tmp/dsh-tavern-install.sh
```

安装完成后重新打开官方 DeepSeek Harness。安装器将酒馆注册到官方固定使用的 `desktop` 配置，不需要切换 Profile。旧 `tavern` 配置中的自定义插件和用户补丁会合并到新配置，原配置保留；人物卡、正文、会话历史继续使用 `profile-data/tavern/`。更新前退出桌面应用，再运行同一安装命令。

旧版内置更新失败时，也直接运行上面的命令：它会获取安装器，绕过本地旧更新脚本（CDN 缓存可能延迟刷新）。Windows 命令按 UTF-8 解码，避免中文乱码。

Windows 安装失败时，请提供终端显示的 `update-diagnostics.jsonl` 文件，默认位于 `%USERPROFILE%\.dsh\profile-data\tavern\data\`；自定义 `DSH_HOME` 时以终端显示的位置为准。日志记录实际安装路径、失败步骤、退出码和脱敏后的错误输出。包管理环境首次下载失败会尝试三次；文件缺失会直接显示缺失路径。依赖安装期间会实时显示输出。若提示日志写入失败，请保留终端中的具体错误。

### 命令行版

适合希望通过浏览器访问、自己管理服务的用户。需要 Node.js 22.19 或更高版本。无需预装 DSH。安装器使用固定版本的独立 DSH，不复用或修改全局安装；首次安装、指定版本变化、运行时缺失或启动检查失败时才重新下载。建议安装 Git：安装器会建立持久化稀疏缓存，首次只获取运行文件，后续只拉取变化内容，不下载 `docs/`、文档图片、`examples/`、`references/` 和测试文件；没有 Git 时自动回退到完整 ZIP。

#### Windows

打开 PowerShell，运行：

```powershell
$env:DSH_TAVERN_HOST='cli'; $tavernInstaller=[Text.Encoding]::UTF8.GetString((New-Object Net.WebClient).DownloadData('https://raw.githubusercontent.com/flizzywine/dsh-tavern/main/install.ps1')); Invoke-Expression $tavernInstaller
```

#### macOS / Linux / WSL2

打开终端，运行：

```bash
curl -fsSL 'https://raw.githubusercontent.com/flizzywine/dsh-tavern/main/install.sh' -o /tmp/dsh-tavern-install.sh && DSH_TAVERN_HOST=cli sh /tmp/dsh-tavern-install.sh
```

安装程序会自动安装依赖、启动 dsh-tavern，并在首次安装时打开网页。关闭页面后，运行 `dsh-tavern open` 可重新打开；也可运行 `dsh-tavern status`，复制显示的完整访问地址（含鉴权 token，请勿分享）。不要只输入不带 token 的地址，以免出现鉴权提示。更新时优先使用 Git 增量同步；Git 不可用或同步失败时才下载完整 ZIP。

安装、更新与 Android 安装默认通过 [npmmirror 国内镜像](https://npmmirror.com/) 下载 npm 依赖，不修改全局 npm 配置。如需使用其他源，在运行安装命令前设置 `DSH_TAVERN_NPM_REGISTRY`：PowerShell 使用 `$env:DSH_TAVERN_NPM_REGISTRY='https://registry.npmjs.org'`，macOS / Linux 使用 `export DSH_TAVERN_NPM_REGISTRY=https://registry.npmjs.org`。

首次使用时，在左侧栏底部打开 **设置 → 模型**，填写模型服务的 API 密钥。

长对话可在 **设置 → Tavern → 上下文压缩** 中选择每 N 轮或达到指定上下文占用比例时自动压缩，默认保持手动。自动压缩会等待剧情后台结算结束，再一起处理前后台；手动入口仍在 **更多 → 压缩上下文**。详见[上下文压缩说明](auto-compaction.md)。

命令行版的运行时、Profile、配置和游戏数据默认位于 `~/.dsh-tavern/`，与外部 DSH 分开。可通过 `DSH_TAVERN_CLI_HOME` 指定位置；安装后启动器会记住该路径。首次升级时会复制旧 CLI 的配置和游戏数据，保留原件；Desktop / DSHA 数据不会自动迁入。Node.js 仍使用系统安装的版本。

#### 手动安装

如果一键命令仍然无法使用：

1. 在 GitHub 项目页点击 **Code → Download ZIP**，或直接下载 [`main.zip`](https://github.com/flizzywine/dsh-tavern/archive/refs/heads/main.zip)；
2. 解压后进入 `dsh-tavern-main` 文件夹；
3. 在这个文件夹中打开 PowerShell（Windows）或终端（macOS / Linux），确认当前目录可以看到 `package.json`；
4. 如果尚未安装 `pnpm`，先运行 `npm install -g pnpm@11.25.0`，然后运行 `pnpm install --frozen-lockfile`。无需手动安装 DSH，下一步会下载独立版本。

5. 命令行版安装并启动：

```bash
pnpm run install:tavern
pnpm run start:tavern
```

然后使用终端显示的完整访问地址，或运行 `dsh-tavern open`。若当前终端尚未识别该命令，可在仓库目录运行 `node ./bin/dsh-tavern.mjs open`。

如果使用官方 DeepSeek Harness，请先退出桌面应用，在解压目录的系统终端运行：

```bash
node ./bin/dsh-tavern.mjs install --host desktop
```

然后重新打开官方桌面应用。

### 命令行版的启动、停止与更新

安装完成后，新开一个 PowerShell / 终端即可使用下列命令。Windows、macOS、Linux / WSL2 的 `dsh-tavern` 命令写法相同。**每次只复制你要执行的那条，不要把整张表依次执行。**

| 命令 | 用途 | 什么时候用 |
| --- | --- | --- |
| `dsh-tavern start` | 启动酒馆后台服务 | 开机后，或服务已经停止时 |
| `dsh-tavern open` | 在浏览器中打开当前酒馆 | 服务已启动，但网页关掉了或没有自动打开时 |
| `dsh-tavern status` | 查看服务状态及可用的访问地址 | 确认是否正在运行，或排查网页打不开时 |
| `dsh-tavern stop` | 停止酒馆后台服务 | 暂时不用、备份数据或准备覆盖重装时 |
| `dsh-tavern restart` | 先停止，再启动酒馆服务 | 更新后需要手动重启，或按排错提示重启时 |
| `dsh-tavern update` | 在原安装位置更新酒馆 | 想通过终端更新时 |
| `dsh-tavern install` | 使用当前本地程序安装或修复 Tavern Profile、依赖及所需运行时 | 手动部署或修复本地安装配置时 |
| `dsh-tavern --help` | 显示命令帮助 | 忘记有哪些命令时 |

不带参数运行 `dsh-tavern` 等同于 `dsh-tavern status`。帮助命令也可以写成 `dsh-tavern help` 或 `dsh-tavern -h`。

**启动服务：**

```bash
dsh-tavern start
```

**打开网页：** 只负责打开页面，不会自动启动尚未运行的服务。若提示尚未就绪，先运行上面的启动命令。

```bash
dsh-tavern open
```

**查看运行状态和访问地址：** 地址可能包含鉴权 token，请勿公开分享。

```bash
dsh-tavern status
```

**停止服务：** 停止后网页无法继续生成，已有聊天和人物卡仍保留。先等当前生成结束并保存编辑内容。

```bash
dsh-tavern stop
```

**重启服务：** 如果浏览器没有恢复连接，完成后再运行 `dsh-tavern open`。

```bash
dsh-tavern restart
```

**更新酒馆：** 更新沿用已安装目录，保留数据。完整覆盖重装步骤见[更新](https://flizzywine.github.io/dsh-tavern/#a02--section-6)。

```bash
dsh-tavern update
```

**安装或修复本地配置：** 此命令使用已经下载到本地的程序，不负责获取最新版酒馆源码。第一次安装请使用上面的完整安装命令；要更新程序，请用 `update`，或按覆盖重装步骤重新执行完整安装命令。

```bash
dsh-tavern install --host cli
```

在命令行版环境中，`dsh-tavern install` 默认使用 CLI 宿主；这里显式写出 `--host cli` 便于确认安装目标。`--host desktop` 和 `--host android` 用于对应宿主内安装，命令行版用户无需切换。

**查看帮助：**

```bash
dsh-tavern --help
```

**常见操作顺序：** 开机后先 `start` 再 `open`；只关闭了浏览器，直接 `open`；打不开先看 `status`；更新用 `update`；需要停止服务用 `stop`。关闭终端或浏览器不等于停止后台服务。

命令行版的 `dsh-tavern update` 更新插件，并检查独立 DSH 的版本与启动状态；符合要求就直接复用，否则重新安装指定版本。全局 DSH 的升级不会改变这份运行时。Desktop / DSHA 更新只更新酒馆，保留宿主版本；兼容报错时请自行下载适配宿主版本。Desktop 版由官方 DeepSeek Harness 管理启停。

命令行版默认目录如下（Windows 的 `~` 对应 `%USERPROFILE%`，通常是 `C:\Users\你的用户名`）：

| 内容 | 默认目录 |
| --- | --- |
| 独立 DSH 程序 | `~/.dsh-tavern/runtime/` |
| 人物卡、游戏状态等数据 | `~/.dsh-tavern/profile-data/tavern/data/` |
| 原生会话记录 | `~/.dsh-tavern/profile-data/tavern/sessions/` |

备份游戏时建议复制整个 `~/.dsh-tavern/profile-data/tavern/`。更新或重装运行时不会删除这个目录。设置 `DSH_TAVERN_CLI_HOME` 后，上述路径均位于指定目录下；Desktop / DSHA 使用各自宿主的 Tavern Profile 数据目录。

需要强制重装独立 DSH 时，在本次安装或更新前设置 `DSH_TAVERN_REINSTALL_RUNTIME=1`，完成后取消设置：

```powershell
$env:DSH_TAVERN_REINSTALL_RUNTIME='1'
dsh-tavern update
Remove-Item Env:DSH_TAVERN_REINSTALL_RUNTIME
```

macOS / Linux：

```sh
DSH_TAVERN_REINSTALL_RUNTIME=1 dsh-tavern update
```
