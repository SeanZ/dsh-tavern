import { createStoryRoundsFold } from '../story/story-rounds.js'

export const COMPACTED_ROLLBACK_REASON = '目标剧情已进入压缩摘要，不能原地撤回；请从要保留的楼层创建分支'

export function compactedRollbackReason(events, keepThrough) {
  const fold = createStoryRoundsFold()
  fold.addEvents(events)
  return fold.compactedStories().some(turn => turn > keepThrough) ? COMPACTED_ROLLBACK_REASON : ''
}

export function assertRollbackCompaction(events, keepThrough) {
  const reason = compactedRollbackReason(events, keepThrough)
  if (reason) throw new Error(reason)
}

// 隐藏旧楼层不能撤销模型摘要里的剧情；旧的不一致必须显式提示并停止续写。
export function compactedHistoryWarning(events, suppressedTurns = []) {
  if (!suppressedTurns.length) return ''
  const suppressed = new Set(suppressedTurns.map(Number))
  const fold = createStoryRoundsFold()
  fold.addEvents(events)
  return fold.compactedStories().some(turn => suppressed.has(turn))
    ? '当前摘要仍包含已撤回的剧情。请从要保留的楼层创建分支后继续。' : ''
}
