// 模组联动示例（下游）：手机来电。任务表里的一项「来电」，needs 地图插件的「定位」：
// 定位这一轮做完它才跑，读到定位的产出。信号为零就打不通，否则记一通来电。
// 它不用知道地图怎么算，只认任务名和产出；地图没装时它从不运行。

export const name = 'tavern-plugin-phone-call'
export const inject = ['tavern']

export function apply(ctx) {
  const tavern = ctx.tavern
  if (typeof tavern.job !== 'function') return

  tavern.job({ name: 'call', title: '来电', description: '按定位的信号决定电话能不能打通，记进通话记录。',
    needs: 'tavern-plugin-map:locate',
    run: async ({ gameId, turn, needs }) => {
      const location = needs['tavern-plugin-map:locate']
      const calls = (await tavern.readGameData({ gameId })) || { log: [] }
      const line = location.signal === 0
        ? '第 ' + turn + ' 轮：在「' + location.place + '」没有信号，电话打不通'
        : '第 ' + turn + ' 轮：在「' + location.place + '」接到一通电话（信号 ' + location.signal + ' 格）'
      await tavern.saveGameData({ gameId, data: { log: [...calls.log, line].slice(-30) } })
      console.info('tavern-plugin-phone-call:', line)
    } })
}
