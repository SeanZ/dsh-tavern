// 模组联动示例（下游）：手机来电。挂在地图插件的事件「tavern-plugin-map:updated」上，
// 读地图发布的产出 location：信号为零就打不通，否则记一通来电。
// 它不用知道地图怎么算，只认事件和产出名；地图没装时它什么也不做。

export const name = 'tavern-plugin-phone-call'
export const inject = ['tavern']

export function apply(ctx) {
  const tavern = ctx.tavern
  if (typeof tavern.emit !== 'function') return

  tavern.on('tavern-plugin-map:updated', async ({ gameId, from, data }) => {
    const location = await tavern.readOutput({ gameId, turn: data?.turn, plugin: from, name: 'location' })
    if (!location) return
    const calls = (await tavern.readGameData({ gameId })) || { log: [] }
    const line = location.value.signal === 0
      ? '第 ' + location.turn + ' 轮：在「' + location.value.place + '」没有信号，电话打不通'
      : '第 ' + location.turn + ' 轮：在「' + location.value.place + '」接到一通电话（信号 ' + location.value.signal + ' 格）'
    await tavern.saveGameData({ gameId, data: { log: [...calls.log, line].slice(-30) } })
    console.info('tavern-plugin-phone-call:', line)
  })
}
