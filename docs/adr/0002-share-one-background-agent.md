# 候选与状态结算共享一个后台 Agent

> 状态：由确定性世界书设计部分取代。后台 Session 的生命周期与回退方式由 ADR-0003 修订。

正文生成是前台职责；候选生成和状态结算共享一个对话级持久后台 Session，减少重复注入和反复研究剧情。任务仍以不同 operation 提交：候选只能写候选与向前 `point`，结算只能写获准的派生状态。

世界书先由 Tavern 本地按关键词规则匹配和渲染；候选池超过阈值时，在正文准备阶段以 `worldbook-filter` operation 请求同一个持久后台 Session 筛选。筛选只允许从本次候选池删减，不绕过作者触发条件，也不处理常驻与脚本明确调度的条目。任务绑定、失败恢复、压缩互斥和回退沿用共享后台生命周期，详见[世界书激活设计](https://github.com/flizzywine/dsh-tavern/wiki/%E8%AE%BE%E8%AE%A1%EF%BC%9Aworldbook-recall)。
