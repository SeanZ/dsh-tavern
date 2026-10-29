import { memberOf } from './background-members.js'

// Every kind of background Agent run, by the `task` name it passes to the background
// runner: what it does, which Agent it runs on and what starts it. The 后台任务 page
// lists it and names runs from it. A new kind of task is added here.
// `lock`: it takes its member's slot in the coordinator, so it never runs beside another
// task on that slot (BACKGROUND_BUSY).
const TASKS = [
  { task: 'settlement', name: '变量结算', lane: 'resident',
    does: '按本轮正文更新变量（MVU 状态栏）和人物姿势；开启后台人物设计时，顺带为新出场的人物写档案。',
    trigger: '正文写完、重新生成后，由流程直接启动；失败可在酒馆状态里重试。',
    reads: '本轮正文、上一轮变量', writes: '本轮回复上的变量（MVU）、人物姿势、结算状态', waits: '不等其他任务；下一轮正文、生成选项都要等它完成', lock: true },
  { task: 'candidate', name: '生成选项', lane: 'resident',
    does: '为下一轮生成几条可选的行动或对白。',
    trigger: '点「生成候选项」；开启自动生成时，前台回合结束后自动提交。',
    reads: '结算后的变量、最近剧情', writes: '候选项（对应当前这条回复）', waits: '等变量结算完成；结算还在跑时自动生成会先等', lock: true },
  { task: 'stage-director', name: '舞台导演', lane: 'ephemeral',
    does: '舞台模式下为正文安排演出：立绘、表情、BGM、音效、环境音、物品。每轮最多两次：边写边导开头，写完再导剩下的。',
    trigger: '正文写完（需开启对话气泡与舞台模式）；正文生成过程中也会先导开头几行。',
    reads: '本轮正文（边写边读）、卡里的演出素材', writes: '本轮舞台记录（按回合）', waits: '不等结算；下一轮开始时被取消', lock: false },
  { task: 'polish', name: '正文精修', lane: 'resident',
    does: '审读刚写完的正文并改进措辞；开启自动精修时，本轮结算完成后直接写回正文（不改剧情事实，不让结算和选项失效）。',
    trigger: '点「精修」；开启自动精修时，正文写完就开始审稿。',
    reads: '刚写完的正文', writes: '本轮正文的措辞（自动精修）与精修对比记录', waits: '审稿不等其他任务；写回正文要等本轮结算等后台任务结束', lock: false },
  { task: 'ledger', name: '手动记账', lane: 'resident',
    does: '按玩家要求整理变量台账，修正结算遗漏或错误的数值。',
    trigger: '玩家在酒馆状态里发起。',
    reads: '变量与剧情历史', writes: '台账；下一轮正文读一次', waits: '前台不在生成时才能开始', lock: true },
  { task: 'character-design', name: '人物设计', lane: 'resident',
    does: '为指定人物写人物档案，发布到这局的人物世界书。',
    trigger: '玩家点「设计人物」。',
    reads: '人物世界书、最近剧情', writes: '人物档案、人物世界书；下一轮开始前同步进前台', waits: '前台不在生成时才能开始', lock: true },
  { task: 'phone', name: '手机', lane: 'ephemeral',
    does: '扮演卡里的联系人，在手机聊天里回消息。',
    trigger: '玩家在手机里发消息。',
    reads: '最近 3 段正文、这条聊天记录', writes: '手机聊天记录', waits: '不等其他任务', lock: false },
  { task: 'plugin', name: '插件任务', lane: 'ephemeral',
    does: '插件发起的一次性后台任务，提示词和工具由插件提供。',
    trigger: '插件调用；下一轮开始前会等它结束。',
    reads: '插件给的提示词与工具', writes: '插件数据（按回合）、插件变量', waits: '前台不在生成时才能开始；下一轮开始前要等它', lock: true }
]

// `member`: the resident member it runs on (background-members.js); empty for a fresh Agent.
export const BACKGROUND_TASK_CATALOG = Object.freeze(TASKS.map(item => Object.freeze({ ...item, member: memberOf(item.task) })))
