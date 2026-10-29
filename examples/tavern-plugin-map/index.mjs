// 模组联动示例（上游）：地图。注册一个有自己前缀的成员「测绘员」：系统提示词和工具
// report_location 固定在成员上；任务表里的「定位」每轮结算完后给它一张工单（本轮正文），
// 它用 report_location 交卷，交来的地点和信号就是这一轮的产出。
// 下游的手机插件用 needs 接在它后面，读这份产出。
// 与 tavern-plugin-phone-call 一起放进 Tavern 数据目录的 plugins/ 下试用。
// （产出只在内存里；要在重启后还读得到，另用 publishOutput 存进存档。）

export const name = 'tavern-plugin-map'
export const inject = ['tavern']

export function apply(ctx) {
  const tavern = ctx.tavern
  if (typeof tavern.job !== 'function') return

  // 每局一份的交卷结果：工具执行时写进来，任务读走。
  const reported = new Map()
  tavern.member({ name: 'surveyor', title: '测绘员',
    system: '你是地图测绘员。每次会收到一段故事正文，判断主角现在所在的地点，以及手机信号强度（0 到 4 的整数，地下室、深山、结界里为 0）。'
      + '判断完调用 report_location 交卷，不要输出别的内容。',
    tools: [{ name: 'report_location', description: '报告主角现在的位置和手机信号',
      parameters: { type: 'object', properties: { gameId: { type: 'string' }, place: { type: 'string' }, signal: { type: 'integer', minimum: 0, maximum: 4 } }, required: ['gameId', 'place', 'signal'] },
      execute: async ({ gameId, place, signal }) => { reported.set(gameId, { place: String(place), signal: Number(signal) || 0 }); return { ok: true } } }] })

  // 本轮结算完，地图再动手：结算结果已写进存档，读到的是结算后的局面。
  tavern.job({ name: 'locate', title: '定位', description: '判断主角在哪、手机信号多强，作为本轮产出返回。',
    member: 'surveyor', on: 'turn-settled', if: ({ turn }) => Boolean(turn),
    run: async ({ gameId, turn }) => {
      const latest = await tavern.getTurn({ gameId, turn })
      reported.delete(gameId)
      await tavern.runTask({ gameId, member: 'surveyor',
        prompt: '本局 gameId：' + gameId + '\n\n【本轮正文】\n' + String(latest?.text || '').slice(-3000) })
      const found = reported.get(gameId)
      if (!found) throw new Error('测绘员没有交卷')
      return found   // 本轮产出
    } })
}
