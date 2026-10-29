// 模组联动示例（上游）：地图。每轮变量结算完成后，让自己的成员「测绘员」判断主角现在
// 在哪、手机信号多强，发布成本轮产出（publishOutput），再发出自己的事件
// 「tavern-plugin-map:updated」。下游的手机插件挂在这个事件上，读这份产出。
// 与 tavern-plugin-phone-call 一起放进 Tavern 数据目录的 plugins/ 下试用。

export const name = 'tavern-plugin-map'
export const inject = ['tavern']

export function apply(ctx) {
  const tavern = ctx.tavern
  if (typeof tavern.emit !== 'function') return

  tavern.member({ name: 'surveyor', title: '测绘员' })

  // 任务完成：变量结算这一轮做完，地图再动手（读到的是结算后的局面）。
  tavern.on('task-finished', async ({ gameId, task, status, turn }) => {
    if (task !== 'settlement' || status !== 'completed' || !turn) return
    const latest = await tavern.getTurn({ gameId, turn })
    const { text } = await tavern.runTask({ gameId, member: 'surveyor',
      prompt: '你是地图测绘员。根据下面这一轮正文，判断主角现在所在的地点，以及手机信号强度（0 到 4 的整数，地下室、深山、结界里为 0）。'
        + '只输出一行 JSON：{"place":"…","signal":0}\n\n' + String(latest?.text || '').slice(-3000) })
    let found
    try { found = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) } catch { return }
    await tavern.publishOutput({ gameId, turn, name: 'location', value: { place: String(found.place || ''), signal: Number(found.signal) || 0 } })
    await tavern.emit('updated', { gameId, data: { turn } })
  })
}
