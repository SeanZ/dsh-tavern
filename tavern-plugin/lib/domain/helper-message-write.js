import { isDeepStrictEqual } from 'node:util'
import { diffJson, applyJsonChanges } from './json-mutation.js'
import { commitChatFields, rebaseChatChanges, sameChatMessageIdentity } from './chat-field-transaction.js'
import { normalizeMessageId } from './tavern-helper-context.js'

function conflict() {
  return Object.assign(new Error('消息写入目标或字段已变化，请重新读取后重试'), { code: 'DSH_TAVERN_CHAT_CONFLICT' })
}

// 只保存本次涉及的楼层与头部，不复制完整历史。第零层也是开场完成判断的读取依赖。
export function captureHelperMessageWrite(chat, patches) {
  const indices = new Set((Array.isArray(patches) ? patches : []).filter(patch => patch && typeof patch === 'object')
    .map(patch => normalizeMessageId(chat.messages, patch.message_id)))
  if (chat.mvu?.owner === 'official' && chat.messages.length) indices.add(0)
  const { messages, ...header } = chat
  return { header: structuredClone(header), messages: new Map([...indices].map(index => [index, structuredClone(messages[index])])) }
}

function changesOf(baseline, chat) {
  const changes = [...baseline.messages].flatMap(([index, before]) => diffJson(before, chat.messages[index])
    .map(change => ({ ...change, path: ['messages', index, ...change.path] })))
  for (const key of ['macroState', 'mvu']) changes.push(...diffJson(baseline.header[key], chat[key])
    .map(change => ({ ...change, path: [key, ...change.path] })))
  return changes
}

function sameTarget(before, current, index) {
  return sameChatMessageIdentity(before, current, index)
    && ['id', 'role', 'turn', 'greeting', 'text', 'sourceText', 'projectionText', 'swipes', 'source', 'nativeAnchor']
      .every(key => isDeepStrictEqual(before[key], current[key]))
    && (before.swipeId ?? 0) === (current.swipeId ?? 0)
}

export async function commitHelperMessageWrite({ baseline, chat, patchChat, resolveChat, assertCurrent }) {
  const desired = changesOf(baseline, chat)
  const before = baseline.header
  const metadata = { source: 'tavern-helper.messages', assertCurrent }
  const receipt = await commitChatFields(patchChat, chat.id, metadata, async attempt => {
    assertCurrent()
    if (attempt === 0) return { revision: before._storageRevision, changes: desired }
    const latest = await resolveChat()
    if (!latest || ['id', 'sessionId', 'cardPath', 'cardContextRevision', 'mode']
      .some(key => !isDeepStrictEqual(before[key], latest[key]))
      || (before.tavernHelperLifecycleRevision ?? 0) !== (latest.tavernHelperLifecycleRevision ?? 0)
      || before.timeline?.branchId !== latest.timeline?.branchId
      || before.mvu?.owner !== latest.mvu?.owner || before.mvu?.enabled !== latest.mvu?.enabled) throw conflict()
    for (const [index, message] of baseline.messages) {
      if (!sameTarget(message, latest.messages[index], index)) throw conflict()
    }
    // 同一开场已被等价写入完成时保留其完成时间，变量本身仍须通过冲突校验。
    const completed = chat.mvu?.openingInitialization?.status === 'complete'
      && latest.mvu?.openingInitialization?.status === 'complete'
    const keep = change => !completed || change.path[0] !== 'mvu' || change.path[1] !== 'openingInitialization'
    const pending = rebaseChatChanges(desired.filter(keep), changesOf(baseline, latest).filter(keep))
    if (!pending) throw conflict()
    if (chat.mvu?.openingInitialization?.status === 'complete' && before.mvu?.openingInitialization?.status !== 'complete') {
      const opening = applyJsonChanges(latest.messages[0], pending.filter(change => change.path[0] === 'messages' && change.path[1] === 0)
        .map(change => ({ ...change, path: change.path.slice(2) })))
      if (!opening?.variables?.length || !opening.variables.every(value => value && value.stat_data !== undefined && value.schema !== undefined)) throw conflict()
    }
    return { revision: latest._storageRevision, changes: pending }
  })
  if (!receipt) throw conflict()
  return receipt
}
