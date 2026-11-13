// 故事公开方法保持稳定，依赖只包含本组实际使用的服务。
// 从楼层创建分支走通用的 prepareConversationFork / forkChat（rpc/conversations.js），这里不再有专用分叉入口。
export function createStoryHandlers({
  snapshots,
  resultSwitch,
  refreshDisplay,
  interruptQueued,
  notifyTimeline
}) {
  return {
    async refreshSessionDisplay(args) {
      if (typeof args?.sessionId !== 'string' || !args.sessionId) throw new Error('刷新显示需要 sessionId')
      return { view: await refreshDisplay(args.sessionId) }
    },
    async saveFloorSnapshot(args) {
      return await snapshots.save(args || {})
    },
    async getFloorSnapshots(args) {
      return await snapshots.read(args || {})
    },
    async interruptStoryQueue(args) {
      return await interruptQueued(args || {})
    },
    async switchFloorResult(args) {
      const result = await resultSwitch.switchResult(args || {})
      if (result.switched)
        notifyTimeline(args.sessionId, 'edit', { settled: true })
      return result
    }
  }
}
