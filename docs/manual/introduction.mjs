// Commands mirror docs/installation.md; tests guard against drift.
export const installCommands = {
  desktopWindows: "$env:DSH_TAVERN_HOST='desktop'; $tavernInstaller=[Text.Encoding]::UTF8.GetString((New-Object Net.WebClient).DownloadData('https://raw.githubusercontent.com/flizzywine/dsh-tavern/main/install.ps1')); Invoke-Expression $tavernInstaller",
  desktopMac: "curl -fsSL 'https://raw.githubusercontent.com/flizzywine/dsh-tavern/main/install.sh' -o /tmp/dsh-tavern-install.sh && DSH_TAVERN_HOST=desktop sh /tmp/dsh-tavern-install.sh",
  cliWindows: "$env:DSH_TAVERN_HOST='cli'; $tavernInstaller=[Text.Encoding]::UTF8.GetString((New-Object Net.WebClient).DownloadData('https://raw.githubusercontent.com/flizzywine/dsh-tavern/main/install.ps1')); Invoke-Expression $tavernInstaller",
  cliUnix: "curl -fsSL 'https://raw.githubusercontent.com/flizzywine/dsh-tavern/main/install.sh' -o /tmp/dsh-tavern-install.sh && DSH_TAVERN_HOST=cli sh /tmp/dsh-tavern-install.sh",
}
const code = (language, text) => '\n```' + language + '\n' + text + '\n```\n'

export const introduction = `
## DSH Tavern 是什么

DSH Tavern 是一个以文字为主的 AI 角色扮演与故事游玩工具，提供类似 SillyTavern 的文字游戏体验。导入一张人物卡，就可以进入它设定的世界，与角色对话、采取行动，让故事继续发展。

它运行在 DeepSeek Harness（简称 DSH）上：DSH 提供模型连接和运行环境，Tavern 提供人物卡、游玩界面、资源工作台和相关功能。名字里虽有 DeepSeek，但所有模型都能用，不限于 DeepSeek 模型。你现在看到的是使用文档，实际游戏需要安装后打开。

## 宣传视频

[DSH Tavern 3 分钟实机演示：兼容酒馆生态，更快、更稳、更鲜活](https://www.bilibili.com/video/BV1MHaU6NE7S/)

## 两种主要使用方式

| 模式 | 你在做什么 | 常见用法 |
| --- | --- | --- |
| 游玩模式 | 参与故事，与角色互动 | 自由输入行动、选择候选；也可以绑定小说或大纲，沿着剧本玩 |
| 卡片模式 | 与 Agent 讨论和修改资源 | 把卡中不喜欢的设定改掉，调整世界书和预设，或从剧本中提取新人物卡 |

两种模式可以独立使用。不需要先学会制卡才能玩，也不需要重做一张卡才能调整自己的体验。

## 打开后，界面大概是什么样

整体是“左侧找对话，中间阅读或操作，右侧看状态与资源”的布局。本页界面截图使用专门创作的公开样例，不包含私人对话或配置；点击图片可放大查看。

| 区域 | 游玩时 | 制作或修改内容时 |
| --- | --- | --- |
| 左侧栏 | 新建游戏，继续和整理已有故事 | 新建工作台，继续之前的资源讨论 |
| 中间主区域 | 阅读剧情、输入行动，选择候选或重写正文 | 告诉 Agent 修改要求，讨论方案，确认修改 |
| 右侧栏 | 查看 Guide、人物状态和剧本进度 | 查看人物卡库、世界书库、剧本库和预设库，编辑或引用资源 |

人物卡可能自带正文美化和状态栏，所以不同卡的展示细节会不同。主体始终是文字故事，插画是可选的高级能力。

## 界面截图

## 一次游玩是怎样的

1. 选一张喜欢的人物卡，预览并确认开场。
2. 阅读故事，输入自己的行动或对白；没想好时可以看看候选建议。
3. 发送行动，等待新的剧情与状态结果。
4. 继续下一轮；不满意时可以重写、回退，或添加持续生效的 Guide。

例如，你可以直接写“我先不回答，走到窗边看看街上的情况”，不必按固定选项行动。

## 可以带来什么内容

支持导入酒馆人物卡、世界书和预设，也可以导入小说、剧本或大纲。正则、MVU 和前端美化的具体支持范围，见[酒馆生态兼容](#compatibility)。

想改变内容时，进入[卡片模式](#cards)，告诉 Agent 哪些不喜欢、希望怎样调整，以及哪些需要保留。它也可以从素材中抽取人物与设定来制作新卡。

## 开始前需要准备什么

- 一台可运行 DSH 的设备，按[安装与启动](#a02)选择桌面版或命令行版。
- 一个可用的文字模型服务（任意模型均可，不限于 DeepSeek），准备服务地址、模型名称和所需的 API 密钥；模型调用可能产生费用。
- 一张想玩的 PNG / JSON 人物卡；也可以安装后再通过卡片模式制作。

不用先导入外部预设。长期偏好、文生图和其他高级设置都可以先跳过，遇到需要时再查。

## 下一步

还没安装：先看[安装与启动](#a02)。已经装好：从[完成第一次游玩](#a04)开始，再按需要查阅各部分功能文档。
`

export const installation = `
## 选一种安装方式

| 你的设备 | 安装方式 |
| --- | --- |
| Windows / macOS 电脑 | [桌面版](#a02--section-2)：装好 DeepSeek Harness，再运行一条命令（推荐） |
| 想用浏览器玩，或用 Linux | [命令行版](#a02--section-3)：需要 Node.js，运行一条命令 |
| Android 手机 | [Android APK](#a02--section-4)：下载安装即可 |

只装一种。不同方式的数据互相独立，换方式不会带走原来的聊天和人物卡。

## 桌面版（Windows / macOS）

### 1. 安装 DeepSeek Harness

从 [DSH 下载页面](https://www.deepseek.com/harness/)下载并安装 **0.2.1-rc.2**。其他版本不保证兼容，看到新版提示也先别升级。

装好后打开一次，再完全退出：Windows 在右下角托盘里退出，macOS 按 ⌘Q。

### 2. 运行安装命令

**Windows：**从开始菜单打开 **PowerShell**，粘贴下面这行，按回车。

` + code('powershell', installCommands.desktopWindows) + `

**macOS：**打开「终端」，粘贴下面这行，按回车。

` + code('bash', installCommands.desktopMac) + `

点代码框右上角的 **复制**，就能拿到完整命令。命令要粘贴到系统终端里，不是 DSH 的聊天框。等终端显示「DSH Tavern 已安装」再关窗口；报错时看[出问题时](#a02--section-7)。

### 3. 打开酒馆

重新打开 DeepSeek Harness，看到酒馆界面就装好了。以后直接打开 DeepSeek Harness 即可。

想用手机玩电脑上的酒馆：打开 **设置 → 手机访问**，选局域网或公网，用手机扫码。电脑和酒馆要保持运行。

想切回原版 DSH：**设置 → 原版DSH → 切到原版 DSH 并重启**。在原版的 **设置 → DSH酒馆** 里可以再切回来。

## 命令行版（Windows / macOS / Linux）

不需要桌面版。命令行版自带一套独立的 DSH，装在自己的目录里（默认 \`~/.dsh-tavern\`），不会改动你已有的 DSH。

### 1. 准备 Node.js

安装 [Node.js](https://nodejs.org/) **22.19 或更高版本**，然后重新打开终端，运行 \`node --version\` 确认。

### 2. 运行安装命令

**Windows（PowerShell）：**

` + code('powershell', installCommands.cliWindows) + `

**macOS / Linux：**

` + code('bash', installCommands.cliUnix) + `

首次安装会问装在哪里，不确定就选 1（用户目录下的 \`.dsh-tavern\`）。装完会尝试打开浏览器，没打开就运行 \`dsh-tavern open\`。

### 3. 日常使用

| 命令 | 作用 |
| --- | --- |
| \`dsh-tavern start\` | 启动服务 |
| \`dsh-tavern open\` | 在浏览器打开酒馆 |
| \`dsh-tavern status\` | 查看是否在运行、访问地址 |
| \`dsh-tavern stop\` | 停止服务 |
| \`dsh-tavern update\` | 更新酒馆 |

开机后先 \`start\` 再 \`open\`。关掉浏览器不会停止服务。访问地址里带有鉴权 token，不要分享给别人。

## Android APK（Android 11+ / ARM64）

1. [下载 DSH Tavern Android APK](https://github.com/flizzywine/dsh-tavern/releases/latest/download/dsh-tavern-android-release.apk)，按系统提示允许安装。
2. 打开 **DSH Tavern**，按首次引导完成部署，等它自动进入酒馆。期间不要退出应用。
3. 以后直接打开应用，点 **启动 → 进入**。

APK 自带运行环境，不用另装 DSHA。它能和旧版 v2.1 APK、原版 DSHA 同时安装，但数据不互通，旧包的存档要先导出再导入。

## 开始游玩

装好后还要配一个文字模型，角色才能回复：

1. 在酒馆左侧栏底部打开 **设置 → 模型**，填入服务地址、API 密钥和模型名。任何模型都可以，不限于 DeepSeek，见[配置文字模型](#a03)。
2. 导入一张 PNG / JSON 人物卡，新建游玩，发送第一句话。详见[第一次游玩](#a04)。

## 更新

点酒馆左侧栏底部的 **检查更新 → 进行更新**，完成后按提示重启或刷新。更新只替换程序，人物卡、聊天和设置都会保留。

应用内更新失败时，重新运行当初的安装命令就是覆盖更新，同样保留数据，不用先卸载。Android 应用本身的新版本从 [Releases](https://github.com/flizzywine/dsh-tavern/releases) 下载，覆盖安装，不要先卸载。

## 出问题时

- **终端报错：**保留最前面的那条错误，不要只截最后一句「失败」。桌面版先确认 DeepSeek Harness 是 0.2.1-rc.2 并且已经完全退出，再重新运行命令。
- **重启后没有酒馆界面：**确认安装命令最后显示了「DSH Tavern 已安装」，再完全退出并重新打开 DeepSeek Harness。
- **命令行版网页打不开：**运行 \`dsh-tavern status\` 看服务是否在运行；没运行就 \`dsh-tavern start\`，再 \`dsh-tavern open\`。
- **能打开但角色不回复：**这不是安装问题，检查[文字模型配置](#a03)。

还解决不了，带上系统版本、安装方式和完整错误，到 [GitHub Issues](https://github.com/flizzywine/dsh-tavern/issues) 反馈；记得隐藏 API 密钥和访问地址里的 token。更多见[常见问题](#n08)，目录和环境变量等高级设置见[完整安装说明](https://github.com/flizzywine/dsh-tavern/blob/main/docs/installation.md)。
`

export const appearance = `
## 选择皮肤

CLI、Desktop 和 Android 酒馆均自带 [Dream Skin](https://github.com/RevolutionLA/dsh-dream-skin)（内置适配版本 9.23.0），无需另装。

1. 打开 **设置 → Theme / 外观**。
2. 选择“酒馆 · 暖陶土”浅色或深色，也可以选择其他皮肤。
3. 返回酒馆查看效果，按钮、面板、边框和正文强调色会随当前主题切换。

## 背景与壁纸

首次默认无背景图片；切换部分皮肤时会应用对应渐变，也可以自行设置或清空壁纸。已有皮肤、强调色和壁纸设置保留。

## 旧版如何使用

通过酒馆原有更新入口升级并重启后即可使用，无需重装 Desktop 或 APK。更新步骤见[安装与更新](#a02)。
`
