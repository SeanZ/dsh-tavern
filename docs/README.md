# dsh-tavern 文档

正式使用文档统一在 [GitHub Wiki](https://github.com/flizzywine/dsh-tavern/wiki)维护，登录 GitHub 即可直接编辑。此目录只保留工程设计、架构与历史研究资料，不再维护使用手册或网站副本。旧文档网站已停用。

## 权威文档

- [领域契约](../CONTEXT.md)：Story Timeline、前后台轮次和持久化边界的当前定义。
- [产品设计原则](product-design.md)：项目使命、核心体验，以及 Agent、上下文、生态组合、候选和剧本等产品取舍。
- [软件不是代码的集合](software-is-experience.md)：AI 加速实现之后，真实体验、反复测试与产品打磨仍由人完成。
- [插件生态](plugin-ecosystem.md)：开放插件接口，像市场汇总分散信息一样，把一个人想不到的巧思以插件形式吸收进来。
- [架构与领域语言](architecture.md)：统一术语、DSH seam、领域模块、适配器和关键规则。
- [TODO](todo.md)：当前优先级、后续功能与发布门槛。

## 设计与决策

- [`adr/`](adr/)：已经接受的关键架构决策。
- [`design/`](https://github.com/flizzywine/dsh-tavern/wiki/%E5%BC%80%E5%8F%91%E8%80%85%EF%BC%9A%E8%AE%BE%E8%AE%A1%E6%96%87%E6%A1%A3)：剧情时间线、剧本游标、状态栏、文风 Skill、[大型人物卡机制工程化备忘](https://github.com/flizzywine/dsh-tavern/wiki/%E8%AE%BE%E8%AE%A1%EF%BC%9Alarge-card-engineering-memo)（结算 Agent 自主检索变量与规则）、[从 LLM 游戏重新审视酒馆生态](https://github.com/flizzywine/dsh-tavern/wiki/%E8%AE%BE%E8%AE%A1%EF%BC%9Arethinking-tavern-ecosystem-as-llm-games)、[Agent 自主上下文](https://github.com/flizzywine/dsh-tavern/wiki/%E8%AE%BE%E8%AE%A1%EF%BC%9Aagent-owned-context)、[最后一轮整体替换](https://github.com/flizzywine/dsh-tavern/wiki/%E8%AE%BE%E8%AE%A1%EF%BC%9Alast-round-replacement)、[编排策略与酒馆脚本运行模块架构](https://github.com/flizzywine/dsh-tavern/wiki/%E8%AE%BE%E8%AE%A1%EF%BC%9Aorchestration-strategies-and-tavern-script-module)、[官方 MVU 本地运行时迁移方案](https://github.com/flizzywine/dsh-tavern/wiki/%E8%AE%BE%E8%AE%A1%EF%BC%9Aofficial-mvu-runtime-migration)、[MVU 只结算、不注入前台备忘](https://github.com/flizzywine/dsh-tavern/wiki/%E8%AE%BE%E8%AE%A1%EF%BC%9Amvu-settlement-only-memo)、[持久化状态视图 Runtime 改造方案](https://github.com/flizzywine/dsh-tavern/wiki/%E8%AE%BE%E8%AE%A1%EF%BC%9Apersistent-status-view-runtime)、[LLM-Harness 架构总纲](https://github.com/flizzywine/dsh-tavern/wiki/%E8%AE%BE%E8%AE%A1%EF%BC%9Allm-harness-architecture)、[当前纯兼容模式阶段备忘](https://github.com/flizzywine/dsh-tavern/wiki/%E8%AE%BE%E8%AE%A1%EF%BC%9Atavern-pure-compatibility-phase-memo)、[酒馆能力在 LLM Harness 中的重新安置](https://github.com/flizzywine/dsh-tavern/wiki/%E8%AE%BE%E8%AE%A1%EF%BC%9Atavern-capabilities-in-llm-harness)、[世界书召回](https://github.com/flizzywine/dsh-tavern/wiki/%E8%AE%BE%E8%AE%A1%EF%BC%9Aworldbook-recall)、[运行时预设](https://github.com/flizzywine/dsh-tavern/wiki/%E8%AE%BE%E8%AE%A1%EF%BC%9Apreset-library)、[酒馆预设到 DSH 原生预设转换协议](https://github.com/flizzywine/dsh-tavern/wiki/%E8%AE%BE%E8%AE%A1%EF%BC%9Atavern-to-dsh-preset-conversion)、[单会话可追溯压缩](https://github.com/flizzywine/dsh-tavern/wiki/%E8%AE%BE%E8%AE%A1%EF%BC%9Acontext-compaction-drilldown)、[正则三层语义备忘](https://github.com/flizzywine/dsh-tavern/wiki/%E8%AE%BE%E8%AE%A1%EF%BC%9Aregex-three-layer)、[DSH 对话内 HTML](https://github.com/flizzywine/dsh-tavern/wiki/%E8%AE%BE%E8%AE%A1%EF%BC%9Ahtml-in-dsh-messages)、[助手正文投影与内联 HTML 改造](https://github.com/flizzywine/dsh-tavern/wiki/%E8%AE%BE%E8%AE%A1%EF%BC%9Ainline-message-renderer-refactor)、[高 ROI 酒馆兼容功能](https://github.com/flizzywine/dsh-tavern/wiki/%E8%AE%BE%E8%AE%A1%EF%BC%9Ahigh-roi-sillytavern-compatibility)和[SillyTavern 生态翻译](https://github.com/flizzywine/dsh-tavern/wiki/%E8%AE%BE%E8%AE%A1%EF%BC%9Asillytavern-translation)设计。
- [`specs/`](specs/)：产品规格，包括[卡片工作台](specs/card-workbench.md)、[候选项容错与用户配置保留需求](specs/candidate-tolerance-and-user-config.md)以及[场景配图功能草案](specs/scene-illustration.md)。
- [`reviews/`](reviews/)：历史审查及实施记录，不作为当前架构入口。
- [`research/`](research/)：外部项目、兼容机制、产品判断与故障研究。统一入口见[参考项目库](research/reference-projects.md)，已有专题包括[《灯火阑珊》MVU 兼容链路验收](research/lighthouse-mvu-compatibility-e2e-2026-08-28.md)、[人物卡自带 `phone-ctn` 小手机调研](research/card-native-phone-phone-ctn-audit-2026-09-05.md)、[强烈而旺盛的角色扮演游戏需求备忘](research/roleplaying-demand-memo.md)、[酒馆预设兼容边界备忘](research/preset-compatibility-boundary-memo.md)、[酒馆正则如何把 `【首页】` 变成可交互卡片](research/sillytavern-regex-rendering-memo.md)、[梨园架构研究与借鉴范围](research/liyuan-architecture-reference.md)、[dsh-visualize HTML 嵌入机制](research/dsh-visualize-html-embedding.md)以及[Windows 聊天落盘、候选失败与后台压缩排查报告](research/windows-chat-persistence-and-background-compaction-diagnosis-2026-08-27.md)。研究文档通常只提供证据；其中正则渲染备忘已由对应设计明确采纳为兼容基线。

用户功能和演示见项目 [README](../README.md)；安装、更新、数据备份及排错见[安装说明](https://github.com/flizzywine/dsh-tavern/wiki/%E5%AE%89%E8%A3%85%E3%80%81%E6%9B%B4%E6%96%B0%E4%B8%8E%E6%95%B0%E6%8D%AE%E5%A4%87%E4%BB%BD)。

v3.0 发布说明见 [变更记录](https://github.com/flizzywine/dsh-tavern/releases) 和 [完整提交清单](https://github.com/flizzywine/dsh-tavern/releases)。

## 查找资料

| 目录 | 用途 |
| --- | --- |
| [`design/references/`](https://github.com/flizzywine/dsh-tavern/wiki/%E5%BC%80%E5%8F%91%E8%80%85%EF%BC%9A%E8%AE%BE%E8%AE%A1%E6%96%87%E6%A1%A3) | Apple、Claude 的视觉参考，不作为项目架构规范 |
| [`plans/`](plans/) | 分阶段实施计划；是否完成应结合验证记录判断 |
| [`implementation/`](implementation/) | 特定功能的实施记录 |
| [`verification/`](verification/) | 测试、性能与真实环境验收证据 |
| [`testing/`](testing/) | 测试边界与方法；运行入口见 [测试目录说明](../tests/README.md) |
| [`experiments/`](experiments/) | 实验方法和结果；可执行脚本放在 [`scripts/experiments/`](../scripts/experiments/) |
| [`releases/`](https://github.com/flizzywine/dsh-tavern/releases) | 历史版本发布记录 |

历史方案和验证记录保留当时的结论，不自动代表当前实现；当前行为优先核对领域契约、正式实现及对应测试。本地研究副本和临时请求快照已清理，受跟踪的报告与证据仍保留。
