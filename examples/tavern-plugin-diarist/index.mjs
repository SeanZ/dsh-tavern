// 后台成员示例：注册一个常驻后台 Agent「日记员」，把一个结算任务挂到它身上，
// 每轮结算后让它用一句话记下这一轮发生了什么。日记员每局一个，有自己的会话和缓存，
// 记得前几轮写过什么；它和酒馆的书记各跑各的，互不排队。
// 再用 tavern.on 挂到事件表上，正文一写完就在日志里打一行。
// 整个文件夹复制到 Tavern 数据目录的 plugins/ 下即可加载；后台任务页的任务目录、
// 时序图和「触发关系」里都能看到它。

export const name = 'tavern-plugin-diarist'
export const inject = ['tavern']

export function apply(ctx) {
  const tavern = ctx.tavern
  if (typeof tavern.member !== 'function') return

  tavern.member({ name: 'diarist', title: '日记员' })

  tavern.settlementTask({
    name: 'diary', title: '剧情日记', phase: 'after', member: 'diarist',
    async run({ gameId, turn, text, runAgent }) {
      const { text: line } = await runAgent({
        prompt: '你是这局游戏的日记员。用一句不超过 40 字的话记下下面这一轮发生了什么，只输出这句话。\n\n' + text.slice(-3000)
      })
      const saved = (await tavern.readGameData({ gameId })) || { entries: [] }
      const entries = [...saved.entries.filter(entry => entry.turn !== turn), { turn, line: line.trim() }].slice(-50)
      await tavern.saveGameData({ gameId, data: { entries } })
    }
  })

  tavern.on('reply-committed', ({ gameId }) => {
    console.info('tavern-plugin-diarist: 正文写完', gameId)
  })
}
