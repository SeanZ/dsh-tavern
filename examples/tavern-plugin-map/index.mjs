// 模组联动示例（上游）：地图。任务表里的一项「定位」：每轮变量结算完成后，让自己的成员
// 「测绘员」判断主角现在在哪、手机信号多强，把结果作为这一轮的产出返回。
// 下游的手机插件用 needs 接在它后面，读这份产出。
// 与 tavern-plugin-phone-call 一起放进 Tavern 数据目录的 plugins/ 下试用。
// （产出只在内存里；要在重启后还读得到，另用 publishOutput 存进存档。）

export const name = 'tavern-plugin-map'
export const inject = ['tavern']

export function apply(ctx) {
  const tavern = ctx.tavern
  if (typeof tavern.job !== 'function') return

  tavern.member({ name: 'surveyor', title: '测绘员' })

  // 变量结算这一轮做完（任务完成），地图再动手，读到的是结算后的局面。
  tavern.job({ name: 'locate', title: '定位', description: '判断主角在哪、手机信号多强，作为本轮产出返回。',
    member: 'surveyor', on: 'task-finished', condition: '变量结算完成时',
    if: ({ task, status, turn }) => task === 'settlement' && status === 'completed' && Boolean(turn),
    run: async ({ gameId, turn }) => {
      const latest = await tavern.getTurn({ gameId, turn })
      const { text } = await tavern.runTask({ gameId, member: 'surveyor',
        prompt: '你是地图测绘员。根据下面这一轮正文，判断主角现在所在的地点，以及手机信号强度（0 到 4 的整数，地下室、深山、结界里为 0）。'
          + '只输出一行 JSON：{"place":"…","signal":0}\n\n' + String(latest?.text || '').slice(-3000) })
      const found = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
      return { place: String(found.place || ''), signal: Number(found.signal) || 0 }
    } })
}
