// Every kind of background Agent run, by the `task` name it passes to the background
// runner: what it does, which Agent it runs on and what starts it. The 后台任务 page
// lists it and names runs from it. A new kind of task is added here.
export const BACKGROUND_TASK_CATALOG = Object.freeze([
  { task: 'settlement', name: '变量结算', lane: 'resident',
    does: '按本轮正文更新变量（MVU 状态栏）和人物姿势；开启后台人物设计时，顺带为新出场的人物写档案。',
    trigger: '正文写完、重新生成后，由流程直接启动；失败可在酒馆状态里重试。' },
  { task: 'candidate', name: '生成选项', lane: 'resident',
    does: '为下一轮生成几条可选的行动或对白。',
    trigger: '点「生成候选项」；开启自动生成时，前台回合结束后自动提交。' },
  { task: 'stage-director', name: '舞台导演', lane: 'ephemeral',
    does: '舞台模式下为正文安排演出：立绘、表情、BGM、音效、环境音、物品。每轮最多两次：边写边导开头，写完再导剩下的。',
    trigger: '正文写完（需开启对话气泡与舞台模式）；正文生成过程中也会先导开头几行。' },
  { task: 'polish', name: '正文精修', lane: 'resident',
    does: '审读刚写完的正文，给出精修建议；使用独立的常驻会话，不占用结算的 Agent。',
    trigger: '点「精修」；开启精修预审时，正文写完和本轮结算完后自动预审。' },
  { task: 'ledger', name: '手动记账', lane: 'resident',
    does: '按玩家要求整理变量台账，修正结算遗漏或错误的数值。',
    trigger: '玩家在酒馆状态里发起。' },
  { task: 'character-design', name: '人物设计', lane: 'resident',
    does: '为指定人物写人物档案，发布到这局的人物世界书。',
    trigger: '玩家点「设计人物」。' },
  { task: 'phone', name: '手机', lane: 'ephemeral',
    does: '扮演卡里的联系人，在手机聊天里回消息。',
    trigger: '玩家在手机里发消息。' },
  { task: 'plugin', name: '插件任务', lane: 'ephemeral',
    does: '插件发起的一次性后台任务，提示词和工具由插件提供。',
    trigger: '插件调用；下一轮开始前会等它结束。' }
])
