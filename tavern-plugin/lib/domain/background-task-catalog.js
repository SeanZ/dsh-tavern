import { memberOf } from './background-members.js'

// Every kind of background Agent run, by the `task` name it passes to the background
// runner: what it does, which Agent it runs on and what it waits for. The 后台任务 page
// lists it and names runs from it. A new kind of task is added here.
// Which story moments start a task is its task-table declaration's (workflow.js, `task`);
// `manual`: the other ways it starts (the player, a flow), one entry each.
// `needs`: tasks of the same turn it waits for. `blocksNextTurn`: the next turn waits for it.
// `idleForeground`: it starts only while the foreground is not writing.
// `lock`: it takes its member's slot in the coordinator, so it never runs beside another
// task on that slot (BACKGROUND_BUSY). `note`: what else it waits for, in words.

const TASKS = [
  { task: 'settlement', name: '变量结算', lane: 'resident',
    does: '按本轮正文更新变量（MVU 状态栏）和人物姿势；开启后台人物设计时，顺带为新出场的人物写档案。',
    manual: ['重新生成正文后（流程启动）', '失败后在酒馆状态里点重试'],
    reads: '本轮正文、上一轮变量', writes: '本轮回复上的变量（MVU）、人物姿势、结算状态', blocksNextTurn: true, lock: true },
  { task: 'candidate', name: '生成选项', lane: 'resident',
    does: '为下一轮生成几条可选的行动或对白。',
    manual: ['点「生成候选项」', '开启自动生成时，回合结束后自动提交'],
    reads: '结算后的变量、最近剧情', writes: '候选项（对应当前这条回复）', needs: ['settlement'], lock: true },
  { task: 'stage-director', name: '舞台导演', lane: 'ephemeral',
    does: '舞台模式下为正文安排演出：立绘、表情、BGM、音效、环境音、物品。每轮最多两次：边写边导开头，写完再导剩下的。',
    manual: ['正文生成过程中，先导开头几行'],
    reads: '本轮正文（边写边读）、卡里的演出素材', writes: '本轮舞台记录（按回合）', note: '不等结算；下一轮开始时也会取消', lock: false },
  { task: 'polish', name: '正文精修', lane: 'resident',
    does: '审读刚写完的正文并改进措辞；开启自动精修时，本轮结算完成后直接写回正文（不改剧情事实，不让结算和选项失效）。',
    manual: ['点「精修」'],
    reads: '刚写完的正文', writes: '本轮正文的措辞（自动精修）与精修对比记录', note: '审稿不等其他任务；写回正文要等本轮结算等后台任务结束', lock: false },
  { task: 'ledger', name: '手动记账', lane: 'resident',
    does: '按玩家要求整理变量台账，修正结算遗漏或错误的数值。',
    manual: ['在酒馆状态里发起'],
    reads: '变量与剧情历史', writes: '台账；下一轮正文读一次', idleForeground: true, lock: true },
  { task: 'character-design', name: '人物设计', lane: 'resident',
    does: '为指定人物写人物档案，发布到这局的人物世界书。',
    manual: ['点「设计人物」'],
    reads: '人物世界书、最近剧情', writes: '人物档案、人物世界书；下一轮开始前同步进前台', idleForeground: true, lock: true },
  { task: 'phone', name: '手机', lane: 'ephemeral',
    does: '扮演卡里的联系人，在手机聊天里回消息。',
    manual: ['在手机里发消息'],
    reads: '最近 3 段正文、这条聊天记录', writes: '手机聊天记录', lock: false },
  { task: 'plugin', name: '插件任务', lane: 'ephemeral',
    does: '插件发起的一次性后台任务，提示词和工具由插件提供。',
    manual: ['插件调用 runTask'],
    reads: '插件给的提示词与工具', writes: '插件数据（按回合）、插件变量', idleForeground: true, blocksNextTurn: true, lock: true }
]

// `member`: the resident member it runs on (background-members.js); empty for a fresh Agent.
export const BACKGROUND_TASK_CATALOG = Object.freeze(TASKS.map(item => Object.freeze({ ...item, member: memberOf(item.task) })))

// Each task's definition as the page shows it, like a GitHub Actions job: its member, the
// moments (and tasks) that start it with their condition, its other starts, what it needs,
// what needs it, whether the next turn waits for it, what cancels it. All of it is read from
// the declarations: the catalog entry and the task-table jobs naming it (`task`). `trigger`
// and `waits` say the same in one line each; an entry that brings its own (a plugin's
// settlement and manual tasks) keeps them.
export function describeTasks(catalog, jobs = [], momentName = event => event) {
  const names = new Map(catalog.map(item => [item.task, item.name]))
  const nameOf = task => names.get(task) || task
  const moments = list => list.map(momentName).join('、')
  return catalog.map(item => {
    const starts = jobs.filter(job => job.task === item.task)
    const on = starts.map(job => ({ moments: job.on.map(momentName), needs: (job.needs || []).map(nameOf), condition: job.condition || '', flow: Boolean(job.flow) }))
    const manual = Array.isArray(item.manual) ? item.manual : item.manual ? [item.manual] : item.trigger && !starts.length ? [item.trigger] : []
    const needs = (item.needs || []).map(nameOf)
    const neededBy = catalog.filter(other => (other.needs || []).includes(item.task)).map(other => other.name)
    const cancelOn = starts.flatMap(job => job.cancelOn).map(momentName)
    const trigger = item.trigger || [
      ...on.map(start => [start.moments.join('、') + (start.flow ? '，由流程直接启动并等它的结果' : ''), start.needs.length ? start.needs.join('、') + '完成后' : '']
        .filter(Boolean).join('，') + (start.condition ? '（' + start.condition + '）' : '')),
      ...manual
    ].filter(Boolean).join('；')
    const waits = item.waits || [
      needs.length ? '等' + needs.join('、') + '完成' : '',
      item.idleForeground ? '前台不在生成时才能开始' : '',
      item.blocksNextTurn ? '下一轮开始前要等它' : '',
      neededBy.length ? neededBy.join('、') + '要等它完成' : '',
      cancelOn.length ? cancelOn.join('、') + '时取消' : '',
      item.note || ''
    ].filter(Boolean).join('；') || '不等其他任务'
    return { ...item, manual, trigger, waits, spec: { on, manual, needs, neededBy, cancelOn,
      blocksNextTurn: Boolean(item.blocksNextTurn), idleForeground: Boolean(item.idleForeground), lock: Boolean(item.lock), note: item.note || '' } }
  })
}
