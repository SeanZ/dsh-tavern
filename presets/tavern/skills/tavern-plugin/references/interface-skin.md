# 界面皮肤规范

规范版本：**1**

界面皮肤是一个 `.css` 文件。玩家在「设置 › DSH Tavern › 显示与交互 › 界面皮肤」里导入后，酒馆的外观随之改变；选「默认」恢复原样。皮肤只有样式，没有脚本，导入别人的皮肤不会碰到存档、不会运行代码。

酒馆内置一套「纸感（示例）」（来自社区贡献），可在同一处选用；它是整套换装，连配色一起改，适合当参考，不是最省事的写法。

需要改页面结构、加按钮、跑脚本的，不是皮肤，请写[插件](plugin-api.md)。舞台（galgame 画面）的外观另有舞台皮肤，不归本文管。

## 文件格式

- 一个 UTF-8 编码的 `.css` 文件，不超过 5 MB。
- 文件名就是皮肤名：`纸感.css` 导入后显示为「纸感」。
- 字体：用 `@font-face` 以 `data:` 地址内嵌，或用 `local()` 引用玩家电脑上的字体并写好回退。不要引用外部网址，离线和手机上会失效。
- 图片：同样以 `data:` 地址内嵌。

## 生效方式

皮肤的 `<style>` 放在酒馆自己的样式表**之后**，所以选择器优先级相同时皮肤胜出，不需要 `!important`。同一时间只启用一套皮肤；切换、删除立即生效，不用刷新。

## 和「配色」的分工

整体配色归「设置 › Theme / 外观」：玩家在那里选浅色、深色或某套配色，DSH 自己的界面和酒馆都跟着变。界面皮肤叠在配色**之上**，只管酒馆自己的部分。

所以皮肤**不要改 DSH 的 `--dsw-*` 变量**：那一层由配色插件用一整套内部变量绘制，皮肤只能盖住其中一部分，结果会半新半旧，还会让玩家在「Theme / 外观」里换配色时看不出变化。皮肤只改下面的酒馆变量和酒馆类名，这样玩家换哪套配色，皮肤都能叠在上面一起用。

## 推荐写法：先改酒馆变量

改变量最省力，也最不容易随版本失效。默认值都由当前配色推导，皮肤在 `body` 上重写即可：

```css
body {
  --dsh-tavern-accent: #8a5a3c;
  --dsh-tavern-radius-lg: 18px;
}
```

| 变量 | 用途 |
|---|---|
| `--dsh-tavern-accent` | 酒馆的强调色 |
| `--dsh-tavern-accent-soft` | 强调色浅底（选中、悬停） |
| `--dsh-tavern-accent-border` | 强调色描边 |
| `--dsh-tavern-accent-ink` | 主要文字 |
| `--dsh-tavern-accent-muted` | 次要文字 |
| `--dsh-tavern-accent-hairline` | 分隔线 |
| `--dsh-tavern-accent-cream` | 酒馆区域的底色 |
| `--dsh-tavern-accent-surface` | 酒馆卡片、面板底色 |
| `--dsh-tavern-accent-error` | 错误提示 |
| `--dsh-tavern-radius-sm` / `-md` / `-lg` | 圆角 |
| `--dsh-tavern-font-display` | 标题字体 |
| `--dsh-tavern-font-sans` | 界面字体 |

## 深色模式

DSH 处于深色时，`body` 上有 `data-ds-dark-theme` 属性。皮肤若只为浅色设计，请把颜色写在 `body:not([data-ds-dark-theme])` 下，深色时保持原样；若两种都做：

```css
body:not([data-ds-dark-theme]) { --dsh-tavern-accent: #a9583e; }
body[data-ds-dark-theme] { --dsh-tavern-accent: #d4896c; }
```

## 稳定的类名

下表的类名是公开接口：只加不改，确需改名时旧名至少保留 6 个月。表外的类名、元素结构、DSH 宿主带哈希的类名（如 `_titleRow_x1y2`）都不是接口，随时会变，用了就可能在某次更新后失效。

| 类名 | 位置 |
|---|---|
| `.dsh-tavern-shell-active` | 加在 `body` 上，表示酒馆界面已启用；需要只在酒馆里生效的规则可以以它开头 |
| `.dsh-tavern-sidebar` | 左栏 |
| `.dsh-tavern-history-group` | 游玩历史里的一组（同一张人物卡） |
| `.dsh-tavern-history-group-name` | 组名 |
| `.dsh-tavern-history-group-count` | 组内对话数 |
| `.dsh-tavern-history-group-items` | 组内对话列表 |
| `.dsh-tavern-header-items` | 顶栏右侧的按钮组 |
| `.dsh-tavern-assistant` | 一段正文 |
| `.dsh-tavern-user-row` | 一条玩家消息所在的行 |
| `.dsh-tavern-user-bubble` | 玩家消息气泡 |
| `.dsh-tavern-choice-trigger` | 正文下方的「生成候选项」「重新生成正文」等按钮 |
| `.dsh-tavern-status-dashboard` | 右栏「酒馆状态」 |
| `.dsh-tavern-card-grid` | 人物卡网格 |
| `.dsh-tavern-card-grid-item` | 网格里的一张人物卡 |
| `.dsh-tavern-btn` | 酒馆的通用按钮 |

DSH 宿主区域可以用它的 `data-slot` 属性定位（如 `[data-slot="conversation.header"]`），这些由 DSH 维护，酒馆不做承诺。

## 管不到的地方

- 人物卡自带的状态栏、前端界面运行在独立的 iframe 里，样式归卡片自己，皮肤影响不到。
- 舞台用舞台皮肤。
- 改不了文字内容、按钮的有无和顺序。

## 示例

```css
/* 书页：正文换衬线字体、放宽行距，玩家气泡更圆；颜色跟随玩家选的配色 */
body:not([data-ds-dark-theme]) {
  --dsh-tavern-accent: #a9583e;
}
.dsh-tavern-assistant {
  font-family: "LXGW WenKai", "Songti SC", serif;
  line-height: 1.9;
}
.dsh-tavern-user-bubble {
  border-radius: var(--dsh-tavern-radius-lg);
}
```
