import { computeSceneTarget } from './domain/scene-illustration.js'

// Reuse the chat journal's serialization boundary without changing story data.
// The stage record is one atomic write while edits/rollback cannot change its source.
export function stageDirectorCommit(persistence) {
  return async function commit(target, save) {
    let committed = false
    await persistence.update(target.chatId, async chat => {
      const latest = chat.messages.filter(message => message.role === 'assistant').at(-1)
      if (target.operationId && chat.timeline?.operations?.[target.operationId]?.status !== 'completed') {
        throw Object.assign(Error('导演所属正文 operation 已变化'), { retryable: false })
      }
      // The stage depends on this turn's text alone: the branch, the latest turn and the scene key
      // (this reply, its swipe and the story before it) prove it unchanged. Not the timeline
      // revision: choices, the ledger or a character design move it without touching the text.
      if (chat.timeline?.branchId !== target.authority?.branchId ||
          Number(latest?.turn || (latest?.greeting ? 1 : 0)) !== target.turn || computeSceneTarget(chat, target.turn).key !== target.key) {
        throw Object.assign(Error('剧情版本已变化，本次不提交舞台'), { retryable: false })
      }
      const assertActive = () => {
        if (target.context.signal?.aborted || target.context.stopped?.()) throw Object.assign(Error('舞台任务已结束，本次不提交'), { retryable: false })
      }
      assertActive()
      await save(assertActive)
      committed = true
      // undefined retains the existing journal revision; only the stage record changes.
    }, { source: 'stage.commit', touchUpdatedAt: false })
    if (!committed) throw Object.assign(Error('舞台所属对话已不存在'), { retryable: false })
  }
}
