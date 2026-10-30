# 大肥鱼 · DSH 人物卡样板

[DSH Tavern Galgame](https://github.com/jerryzmtz/dsh-tavern-galgame) 分支的示例卡「大肥鱼」做成的 DSH 人物卡（`.dshcard`，见[格式设计](https://github.com/flizzywine/dsh-tavern/wiki/%E8%AE%BE%E8%AE%A1%EF%BC%9Adsh-card-format)）。它是 DSH 人物卡格式的样板：一个文件里有人物卡、4 个素材包、卡内插件、推荐预设和开局设置，导入后不用装别的插件就能玩到 Galgame 式的舞台。已取得原作者同意，作为演示卡分发。

- `plugin/`：卡内插件的源码，只用公开的[插件接口](https://github.com/flizzywine/dsh-tavern/wiki/%E6%8F%92%E4%BB%B6%E5%BC%80%E5%8F%91%EF%BC%9A%E6%8E%A5%E5%8F%A3%E6%80%BB%E8%A7%88)。宿主侧（`index.mjs`）在每轮后台结算里顺带"导演"，按正文选场景、时段、服装和背景音乐，并在本局设置里加「舞台导演」「导演换服装」两个开关；浏览器侧（`client.js`）用 `registerStageView` 画舞台：背景图、当前服装的情绪全身立绘（素材包里分层的立绘按配方拼好）、场景下方的对白框，背景音乐交给 Tavern 播放；并用 `castAssetSource` 把各表情头像交给 Tavern，正文头像随台词情绪变化。
- `presets/`：推荐预设，开新局时默认使用。
- `build.mjs`：从分支发布的卡包生成原料卡 `大肥鱼.source.dshcard`（约 270 MB，原始素材，含 Live2D）。只用来生成分发版，不直接导入。
- `compress.mjs`：从原料卡生成压缩后的 `大肥鱼.dshcard`（约 90 MB）。PNG 转 WebP、音乐和音效转 Ogg Opus，`--drop-live2d` 去掉 Live2D 模型，卡内插件取 `plugin/` 里最新的；每个素材包里写一份 `credits/DSH-CARD-CHANGES.md` 说明改动。
- `RELEASE.md`：发布说明。

- `../dshcard-png.mjs`：把 `大肥鱼.dshcard` 接在封面后面，生成分发版 `大肥鱼.dshcard.png`，就是 Release 里给用户下载的那张：系统和聊天软件显示封面，Tavern 导入整张卡。

这些卡文件都太大，不进仓库（`.gitignore`）。改了插件或预设后重新生成：

```sh
node examples/dafeiyu-card/build.mjs dafeiyu.card-bundle.zip examples/dafeiyu-card/大肥鱼.source.dshcard
node examples/dafeiyu-card/compress.mjs examples/dafeiyu-card/大肥鱼.source.dshcard examples/dafeiyu-card/大肥鱼.dshcard --drop-live2d
node examples/dshcard-png.mjs examples/dafeiyu-card/大肥鱼.dshcard examples/dafeiyu-card/大肥鱼.dshcard.png
```

`compress.mjs` 需要 `cwebp` 和带 libopus 的 `ffmpeg`。

使用：在 Tavern 的人物卡库导入 `.dshcard.png`（或 `.dshcard`；卡内插件随卡启用，舞台随卡打开），刷新页面，开一局；舞台在「酒馆状态」顶部。

`--cast` e2e 在 `大肥鱼.dshcard` 存在时会导入它玩一轮（也可以用 `TAVERN_E2E_DSHCARD` 指定别的路径）。

第一版是样板，不复刻分支的全部功能：没有 Live2D、眨眼、口型、镜头、天气和模组。素材的署名与许可见卡内各素材包的 `credits/`。
