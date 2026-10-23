// 故事公开方法保持稳定，依赖只包含本组实际使用的服务。
export function createStoryHandlers({
  snapshots,
  resultSwitch,
  fork,
  interruptQueued,
  notifyTimeline
}) {
  return {
    async saveFloorSnapshot(args) {
      return await snapshots.save(args || {})
    },
    async getFloorSnapshots(args) {
      return await snapshots.read(args || {})
    },
    async prepareFloorFork(args) {
      return await fork.prepare(args || {})
    },
    async forkFloor(args) {
      return await fork.fork(args || {})
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
