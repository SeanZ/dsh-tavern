# Android 安装与更新

## 独立 APK（Android 11+ / ARM64）

[下载 DSH Tavern Android APK](https://github.com/flizzywine/dsh-tavern/releases/latest/download/dsh-tavern-android-release.apk) · [下载 SHA-256 校验文件](https://github.com/flizzywine/dsh-tavern/releases/latest/download/dsh-tavern-android-release.apk.sha256)

独立 APK 内置 DSHA v0.2.0-rc2 与 DSH 0.2.0-rc.2，只启动酒馆自己的 `tavern` Profile（端口 3080）。手机上只运行这一个 DSH 服务。

1. 下载 APK（约 480 MB，内含酒馆源码与全部依赖），按 Android 提示允许当前浏览器或文件管理器安装应用，然后安装。
2. 打开「DSH Tavern」，按首次引导完成内置环境部署（离线解压，不需联网）；随后应用会就地解包内置的酒馆与依赖并完成安装，**全程不需要联网**，通常 1–3 分钟。
3. 安装完成后会自动进入酒馆；在酒馆设置中配置文字模型，再导入人物卡。
4. 以后直接打开此应用；酒馆源码更新在应用内完成（更新时才联网），更新后返回启动页重启。安装新 APK 时，如果之前没在应用内更新过酒馆源码，启动阶段会直接用新 APK 内置的快照离线升级源码和依赖，不必再等一次联网全量更新。

APK 内置首装所需的源码快照、pnpm 依赖仓库与 pnpm 运行时，首次启动只做本地解包，不再逐包下载。首装完成后源码快照会被清理，依赖缓存则转存到 `~/.dsh/runtime/tavern-pnpm-store`：以后的应用内更新按运行清单只下载有变化的源码文件，依赖直接从本地缓存链接，不再整包重下。缓存占用约一两百 MB，空间紧张时可以删除，下次更新会重新下载。内置依赖缺项（例如源码版本比 APK 新）时会自动改用 npmmirror 联网补齐，失败再用官方源 registry.npmjs.org 重试一次；仍失败时保留错误日志，再点击启动重试。

应用内更新会在侧栏显示安装器当前步骤（下载源码、安装依赖、写入配置等）；手机网络较慢时可能停留较久，但只要有新输出就不会被判定为卡住，整个过程最多 30 分钟。

安装日志位于容器内 `/root/.dsh/logs/tavern-install.log`，每一步都有 `== [步骤 N] …（已用 Xs）==` 抬头和 pnpm 逐行进度，可以直接看出卡在哪一步。

APK 使用独立包名 `io.github.flizzywine.dshtavern.standalone`，可以与旧版 v2.1 APK（DSH 0.1.5）和原版 DSHA 同时安装，数据各自独立。旧版 v2.1 APK 与本包签名不同，不能覆盖升级：先在旧包里导出存档和人物卡，装好本包后按 [数据导入](data-import.md) 导入。两个应用不要同时运行。

Android 安装包不从应用内自更新：新版本从 [Releases](https://github.com/flizzywine/dsh-tavern/releases) 下载，直接覆盖安装同一包名的新 APK。不要为了更新先卸载应用，以免删除应用数据。

Android 上除了独立 APK，也可以在 **Termux** 里跑命令行版（见下节）。独立 APK 要求 Android 11 及以上、ARM64；不再提供通过 DSHA 安装的方式。

> 不同手机系统、网络和后台限制都可能导致安装或运行失败；当前安装脚本只能修复项目已知问题。

## Termux（在手机里跑命令行版）

不想装 480 MB 的 APK、或者想自己掌控运行环境（Node 版本、数据目录、与电脑上的命令行版共用一套玩法），可以在 Termux 里跑命令行版。它和电脑上的命令行版是同一套代码，只是把 Ubuntu 装进了 proot 容器里。

前置：从 [F-Droid](https://f-droid.org/packages/com.termux/) 或 [Termux GitHub Releases](https://github.com/termux/termux-app/releases) 安装 Termux（Android 11+ / ARM64），预留约 1.5 GB 空间。

```sh
curl -fsSL https://raw.githubusercontent.com/flizzywine/dsh-tavern/main/scripts/termux/termux-tavern.sh -o ~/termux-tavern.sh && bash ~/termux-tavern.sh
```

一条命令跑完，始终取 `main` 上的最新版；重复执行同一条命令即为更新（脚本自己会替换到新版）。

> GitHub 访问不稳时，把地址里的 `https://raw.githubusercontent.com/flizzywine/dsh-tavern/main` 换成 `https://cdn.jsdelivr.net/gh/flizzywine/dsh-tavern@main`，路径不变。

脚本一次做完：装 `proot-distro` → 建 Ubuntu 容器 → 装官方 Node 24 → 以 `DSH_TAVERN_HOST=cli` 安装酒馆 → 启用移动版布局（`dsh-web-mobile`，与 APK 同款）→ 启动服务并打开浏览器。首装 10–40 分钟（取决于网络与手机），之后启动约 1 分钟。

日常命令：

| 命令 | 作用 |
| --- | --- |
| `bash ~/termux-tavern.sh` | 启动（已装则跳过安装），打印带 token 的地址并打开浏览器 |
| `bash ~/termux-tavern.sh status` | 运行状态、端口探活、当前地址 |
| `bash ~/termux-tavern.sh stop` | 停止 |
| `bash ~/termux-tavern.sh update` | 只更新酒馆代码，不动容器与 Node |
| `bash ~/termux-tavern.sh logs` | 看服务日志尾部 |
| `bash ~/termux-tavern.sh open` | 不重启服务，只打开当前地址 |

几个必须知道的点：

- **服务跑在常驻 proot 里**。proot 是 syscall 翻译层，`proot-distro login … start` 这类一次性命令返回后容器就没了，服务会跟着死；脚本用 `sleep infinity` 让它常驻，别手动 kill 那个守护进程。
- **数据在容器内 `/root/.dsh-tavern/`**（含人物卡、聊天、设置）；容器用 `proot-distro remove ubuntu` 删除会一起没，删前先导出。
- **后台存活**：Android 12+ 会在后台清理“幽灵进程”。把 Termux 加入电池优化白名单、运行时保持 `termux-wake-lock`；仍被清时可配好无线调试后执行
  `adb shell settings put global settings_enable_monitor_phantom_procs false`。
- **移动布局**由 `dsh-web-mobile` 提供。命令行版默认不装它（桌面宿主才装 `dsh-pocket`），所以脚本会显式写进 Profile；想回退删掉 `profiles/tavern/package.json` 里的依赖、bundle 项和 `pnpm-workspace.yaml` 里的 patch 行即可。
- **脚本会自更新**：每次运行先比对 `scripts/termux/termux-tavern.sh` 的版本号，有新版就替换自己再继续；离线时静默跳过。

### 与独立 APK（DSHA 运行环境）的对比

独立 APK 复用的是 [DSHA](https://github.com/DSH-APP/DSHA)（MIT）已验证过的运行环境：APK 内打包 Ubuntu + Node + DSH，用应用内 WebView 打开界面；Termux 版则是你自己装 Termux，再用 proot-distro 起一个 Ubuntu。

| | 独立 APK（DSHA 环境） | Termux 命令行版 |
| --- | --- | --- |
| 安装方式 | 装 APK，首启按引导离线部署 | 装 Termux 后跑一个脚本（联网装 Ubuntu / Node / 依赖） |
| 首次可用耗时 | 1–3 分钟（离线解包，不联网） | 10–40 分钟（受网络与手机性能影响） |
| 占用空间 | APK 约 480 MB + 应用数据 | 约 1.2–1.5 GB（容器 + Node + 依赖） |
| 运行环境 | APK 自带 Ubuntu + Node（proot） | Termux + proot-distro Ubuntu + 官方 Node 24 |
| 界面 | 应用内 WebView | 系统浏览器（`127.0.0.1:3081`，带 token） |
| 移动布局 | 内置 `dsh-web-mobile` | 脚本自动启用同一个 `dsh-web-mobile` |
| 终端 | 应用内 PTY 终端页 | 用 Termux 自己的终端 |
| 后台保活 | 由应用进程与前台服务管理 | 需 Termux 唤醒锁 / 关电池优化 / 关幽灵进程清理 |
| 数据位置 | 应用私有目录下的 `~/.dsh` | 容器内 `/root/.dsh-tavern` |
| 更新 | 酒馆源码应用内更新；APK 需重新下载覆盖安装 | 脚本内 `update`；脚本本身自更新 |
| 适合谁 | 只想装一个 APK 就玩，不想碰终端 | 已有/愿意用 Termux，想自己控制环境、Node 版本和目录，或与电脑上的命令行版保持一致 |

两者不要同时运行：APK 与 Termux 版都会拉起自己的 DSH 服务，同时开只会多占内存，且数据目录各自独立、互不共享。
