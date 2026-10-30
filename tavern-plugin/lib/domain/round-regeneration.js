import { randomUUID } from 'node:crypto'
import { projectPlayerContent } from './player-input-content.js'
import { assertRescueHistoryEditable } from './chat-history-rescue.js'
import { replaceSessionSurface } from './session-surface-mutations.js'
import { releaseOpeningTurn, sessionEvents } from './session-events.js'
import { projectedReplacingTurns } from './regeneration-recovery.js'
import { applyRegenerationProjection } from './rollback-surface.js'
import { assertRegenerationSourceCurrent, replaceLastRound } from './last-round-replacement.js'
import { diagnosticIdentity } from './regeneration-diagnostics.js'
import { createScopedMessages, isScopedMessages } from './scoped-messages.js'
import { diffJson } from './json-mutation.js'
import { assistantResultForTurn } from './session-turn-result.js'
import { plainReplyProse } from './reply-prose.js'

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

// 存档 revision 被结算或失败轮清理推进时，用最新状态重试有限次数。
const REGEN_WRITE_ATTEMPTS = 4

/**
 * The input of a regeneration attempt. The provider never sees the replaced body
 * (the request projection drops it), so without guidance this is a fresh sample
 * of the round. Guidance ("写得更长", "加快节奏") is relative to the current body,
 * so it comes with that body as the draft to revise.
 */
export function regenerationInputText(userText, guidance, rewriteBody) {
  const input = str(userText).trim(), guide = str(guidance).trim(), draft = str(rewriteBody).trim()
  if (draft !== '' && guide !== '') return input + '\n\n【当前正文】\n' + draft + '\n\n【改写要求】\n在当前正文基础上改写本轮正文：' + guide
  return input + (guide !== '' ? '\n\n【本轮补充要求】\n' + guide : '')
}

// What the model saw of a stored reply (same precedence as the body editor).
// 原生事件只接受 JSON 值；可选字段不用 undefined 占位。
function regeneratedSource(previous, storyTurn, resultTurn, partial, reason) {
  const source = { ...previous, tavernStoryTurn: storyTurn, tavernResultOrigin: partial, tavernResultTurn: resultTurn, tavernIncomplete: partial }
  delete source.tavernResultSeq
  delete source.tavernIncompleteReason
  if (partial && reason !== undefined) source.tavernIncompleteReason = reason
  return source
}

function replyTextOf(message) { return str(message && (message.projectionText ?? message.sourceText ?? message.text)) }

/**
 * Text a streamed attempt had written when its turn ended badly. A turn the
 * provider failed, the player stopped or content moderation cut short often
 * never writes an `assistant/message` at all — but the durable
 * `assistant/attempt` record keeps its chunks, which is exactly what the player
 * watched arrive. Rebuild the text blocks from those chunks.
 */
export function attemptStreamText(events, eventStart, turn) {
  let stream = null
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.type !== 'assistant/attempt' || Number(event.seq) < Number(eventStart)) continue
    if (Number.isSafeInteger(turn) && turn > 0 && Number(event.data?.turn) !== turn) continue
    stream = event.data?.stream
  }
  if (!Array.isArray(stream)) return ''
  const blocks = new Map(), order = []
  function bucket(index) {
    const key = String(index ?? 0)
    if (!blocks.has(key)) { blocks.set(key, { kind: 'text', text: '', closed: '' }); order.push(key) }
    return blocks.get(key)
  }
  for (const entry of stream) {
    if (!entry || typeof entry !== 'object') continue
    if (entry.type === 'chunk') {
      const chunk = entry.chunk
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'block-start') { const item = bucket(chunk.index); if (typeof chunk.blockType === 'string') item.kind = chunk.blockType }
      else if (chunk.type === 'text-delta') { const item = bucket(chunk.index); if (item.closed === '') item.text += str(chunk.text) }
      else if (chunk.type === 'reasoning-delta') bucket(chunk.index).kind = 'reasoning'
      else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') { const item = bucket(chunk.index); item.closed = str(chunk.block.text) }
    } else if (entry.type === 'text-chunks') {
      const item = bucket(entry.index)
      if (item.closed === '' && Array.isArray(entry.texts)) item.text += entry.texts.map(str).join('')
    } else if (entry.type === 'text-delta') {
      const item = bucket(entry.index)
      if (item.closed === '') item.text += str(entry.text)
    }
  }
  return order.map(key => blocks.get(key)).filter(item => item.kind !== 'reasoning').map(item => item.closed !== '' ? item.closed : item.text).join('').trim()
}

/**
 * A regeneration the host never finished still streams its reply into the log
 * before the turn ends (stop, provider error, safety block, truncation). The
 * save only receives a round once the host commits it, so read the streamed text
 * back here and keep it instead of dropping a body the player already saw.
 */
function streamedAttemptText(session, turn, eventStart) {
  if (!Number.isSafeInteger(turn) || turn <= 0) return ''
  try {
    const events = sessionEvents(session)
    const result = assistantResultForTurn(session, turn)
    // The attempt owns its own events: a reply already in the log belongs to the
    // round being replaced, never to this try.
    if (result !== null && str(result.text).trim() !== '' && Number(result.event?.seq) >= Number(eventStart)) return result.text.trim()
    // A failed turn may have numbered its own turn (or not advanced the phase):
    // the stream that started with this attempt is still the one to keep.
    return attemptStreamText(events, eventStart, turn) || attemptStreamText(events, eventStart, 0)
  } catch { return '' }
}

// alpha.2 也会提交 max-tokens 的正式回复；正文是否完整须以本次回合终态为准。
function incompleteGeneration(session, turn, eventStart) {
  const end = sessionEvents(session).findLast(event => event.type === 'turn/end' &&
    Number(event.seq) >= Number(eventStart) && Number(event.data?.turn) === Number(turn))
  return Boolean(end?.data?.reason?.kind && end.data.reason.kind !== 'completed')
}

/** The round a kept partial attempt writes: an ordinary floor, marked as incomplete. */
function partialAttemptRows(input) {
  const attachments = Array.isArray(input.inputAttachments) ? input.inputAttachments : []
  const user = { role: 'user', text: str(input.userText), native: true, ...(attachments.length ? { inputAttachments: structuredClone(attachments) } : {}) }
  const assistant = { role: 'assistant', ...plainReplyProse(input.text), native: true, turn: input.turn,
    incomplete: true, incompleteReason: '这次重新生成被中断，保留了已生成的部分正文' }
  return [user, assistant]
}

// 完整存档与窗口存档共用同一重生成契约，回退协调和互斥仍由 round-history 持有。
export function createRoundRegeneration({ chats, sessions, sessionPatch, diagnostics, storyTimeline, readChatCard, readChat, chatForSession, readChatRevision, updateChat, readScript, scriptContinuity, view, queueSettlement, replyCommitted, cancelSettlement, regenerationRecovery, selectRepairedTarget, placeRegeneration, prepareRollbackIntent, commitOfRound }) {
  async function regenBody(chatId, guidance, sessionId) {
    if (sessionPatch && !sessionPatch.replacementAllowed()) throw new Error(sessionPatch.blockReason())
    let chat = str(chatId) === '' ? await chatForSession(sessionId) : await readChat(chatId)
    if (chat === undefined) throw new Error('聊天不存在: ' + chatId)
    assertRescueHistoryEditable(chat)
    const activeRound = Object.values(storyTimeline.inspect({ chat }).operations || {}).find(function (operation) {
      return operation && operation.kind === 'body' && operation.status === 'completed' &&
        operation.background && ['pending', 'running'].includes(str(operation.background.phase))
    })
    if (chat.regenInProgress === true) throw new Error('正文正在重新生成，请等待完成')
    const card = await readChatCard(chat)
    const storedSessionId = chat.sessionId
    if (typeof sessionId === 'string' && sessionId !== '') chat.sessionId = sessionId
    if (typeof chat.sessionId !== 'string' || chat.sessionId === '') throw new Error('会话未绑定 DSH 会话')
    const agent = sessions.get(chat.sessionId)
    if (agent === undefined || agent.session === undefined) throw new Error('无法访问 DSH 会话: ' + chat.sessionId)
    if (agent.phase?.kind === 'running') throw new Error('前台正在生成，请完成或停止后再重新生成')
    const session = agent.session
    let selection, evidence
    try { selection = await selectRepairedTarget(chat, session, diagnostics ? value => { evidence = value } : undefined) }
    finally {
      if (evidence) {
        try { await diagnostics.record(chat.sessionId, { stage: 'regeneration-target', diagnosticId: randomUUID(),
          outcome: evidence.reason === 'selected' ? 'selected' : 'rejected', ...evidence,
          guidanceProvided: typeof guidance === 'string' && guidance.trim().length > 0,
          binding: { requested: diagnosticIdentity(sessionId), stored: diagnosticIdentity(storedSessionId), effective: diagnosticIdentity(chat.sessionId),
            overridden: Boolean(sessionId && sessionId !== storedSessionId) },
          agent: { phase: ['running', 'idle'].includes(agent.phase?.kind) ? agent.phase.kind : 'other', lastTurn: Number.isFinite(agent.phase?.lastTurn) ? agent.phase.lastTurn : null } }) }
        catch { /* Recording failure must not affect regeneration or replace its error. */ }
      }
    }
    const { eventStart, msgs0, oldAssistantIndex, oldSeq, oldTurn, oldSource } = selection
    // V3 hosts may reject assistant replacements. Check an isolated copy before
    // rolling back the Chat, cancelling settlement or paying for a new reply.
    if (session.header?.version >= 3) {
      const preview = session.constructor.fromRestore(session.id, structuredClone(sessionEvents(session)), structuredClone(session.header), session.inheritedEventCount, 'detached')
      try {
        replaceSessionSurface(preview, 'assistant/message', {
          turn: oldTurn, step: 1,
          message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: msgs0[oldAssistantIndex].text }], source: oldSource }
        }, { start: oldSeq, end: oldSeq, sourceEventSeqs: [oldSeq] })
      } catch (error) {
        if (sessionPatch?.status === 'failed') throw new Error(sessionPatch.reason, { cause: error })
        if (sessionPatch?.serverReady) throw error
        throw new Error('当前 DSH 不支持正文替换，未启动重新生成。' + str(error?.message || error), { cause: error })
      }
    }
    const originalUserText = str(msgs0[oldAssistantIndex - 1].text).trim()
    let originalChat = structuredClone(chat)
    const operationId = randomUUID()
    async function restoreFailedRegen() {
      await regenerationRecovery.abort({ chatId: chat.id, originalChat, session, eventStart, operationId })
    }
    let legacyBefore = null
    if (storyTimeline.inspect({ chat }).checkpointCount === 0) {
      let rollbackCommit = null
      if (chat.nativeCommits !== null && typeof chat.nativeCommits === 'object') {
        // The round's own commit, by its turn; text matching is only for rows saved before turns were recorded.
        rollbackCommit = commitOfRound(chat.nativeCommits, msgs0[oldAssistantIndex], originalUserText)
      }
      const before = rollbackCommit && rollbackCommit.before && typeof rollbackCommit.before === 'object' ? rollbackCommit.before : {}
      legacyBefore = {
        messages: msgs0.slice(0, oldAssistantIndex - 1), posture: str(before.posture), ledger: before.ledger || null, scriptState: chat.scriptState,
        candidates: null, settleStatus: 'idle', settleError: null, lastSettle: null,
        preparedWorldBookContext: str(before.preparedWorldBookContext),
        preparedWorldBook: before.preparedWorldBook || null,
        participants: {}
      }
      if ((chat.mode || 'story') === 'script') {
        const script = await readScript(chat.cardPath)
        if (script === undefined || !Array.isArray(script.chunks)) throw new Error('剧本文件不存在，无法重新生成正文')
        const revision = before.scriptRevision && typeof before.scriptRevision === 'object' ? before.scriptRevision : null
        const reference = rollbackCommit && rollbackCommit.scriptReference && typeof rollbackCommit.scriptReference === 'object' ? rollbackCommit.scriptReference : null
        legacyBefore.scriptState = scriptContinuity.transition({ script, state: chat.scriptState, event: { kind: 'restore', revision, reference } }).state
      }
    }
    const rollbackIntent = await prepareRollbackIntent(chat, { kind: 'turn.rollback', turn: oldTurn, legacyBefore })
    const lifecycleRevision = Math.max(0, Number(originalChat.tavernHelperLifecycleRevision) || 0) + 1
    chat = await updateChat(chat.id, function (current) {
      if (agent.phase?.kind === 'running' || current.regenInProgress) throw new Error('前台正在生成，请完成或停止后再重新生成')
      assertRegenerationSourceCurrent({ originalChat, currentChat: current, assistantIndex: oldAssistantIndex })
      originalChat = structuredClone(current)
      const next = storyTimeline.apply({ chat: current, intent: rollbackIntent }).chat
      next.regenRecovery = { id: operationId, beforeRevision: Number(current._storageRevision || 0),
        ...(Number(current._storageRevision || 0) ? {} : { before: structuredClone(current) }),
        sessionId: chat.sessionId, eventStart }
      next.tavernHelperLifecycleRevision = lifecycleRevision
      next.regenInProgress = true
      // 生成期间先把被重做的旧正文藏起来：否则旧的正文一直挂在页面上，看上去
      // 像"没有在生成、只是把新内容叠上去"。只藏正文，玩家输入是他自己发的，
      // 留着才看得见这条在等谁的回复——所以走 replacingDshTurns，别混进
      // suppressedDshTurns（那是"整轮作废"，会连输入一起收掉）。
      const replacingBefore = Array.isArray(next.replacingDshTurns) ? next.replacingDshTurns : []
      const alreadyReplacing = replacingBefore.some(function (turn) { return Number(turn) === Number(oldTurn) })
      next.regenRecovery.temporaryReplacingTurn = alreadyReplacing ? null : oldTurn
      if (!alreadyReplacing) next.replacingDshTurns = Array.from(new Set(replacingBefore.concat([oldTurn]))).sort(function (left, right) { return left - right })
      return next
    }, { source: 'rollback.regen' })
    const rolledMessageCount = (chat.messages || []).length
    const guide = str(guidance).trim()
    const syntheticText = regenerationInputText(originalUserText, guide, replyTextOf(msgs0[oldAssistantIndex]))
    releaseOpeningTurn(agent.session, agent)
    const beforeLastTurn = agent.phase !== undefined && agent.phase !== null && Number.isFinite(Number(agent.phase.lastTurn)) ? Number(agent.phase.lastTurn) : 0
    let committedChat, body, syntheticTurn, keptPartial = false
    try {
      if (activeRound !== undefined && typeof cancelSettlement === 'function') await cancelSettlement(chat.id)
      if (agent.phase?.kind === 'running') throw new Error('前台正在生成，未启动重新生成')
      const ready = await readChat(chat.id)
      if (ready?.regenRecovery?.id !== operationId || agent.phase?.kind === 'running') throw new Error('重新生成操作已失效或前台正在生成')
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: projectPlayerContent(msgs0[oldAssistantIndex - 1].inputAttachments, syntheticText),
        source: { kind: 'plugin:dsh-tavern-regen', regenerationId: operationId }
      })
      // A stopped, blocked or truncated attempt fails the wait, but the text it
      // already streamed stays in the log. Keep going and adopt that text.
      let generationError = null
      try { await agent.whenIdle() } catch (error) { generationError = error }
      syntheticTurn = agent.phase !== undefined && agent.phase !== null && Number.isFinite(Number(agent.phase.lastTurn)) ? Number(agent.phase.lastTurn) : (beforeLastTurn + 1)
      let latest = await readChat(chat.id)
      if (latest === undefined) {
        throw new Error('聊天不存在: ' + chat.id)
      }
      let latestMsgs = latest.messages || []
      if (latestMsgs.length < rolledMessageCount + 2) {
        const streamed = streamedAttemptText(session, syntheticTurn, eventStart)
        if (streamed === '') {
          if (generationError !== null) throw generationError
          throw new Error('这次重新生成没有完成（可能被内容审核拦截或已停止），正文保持原样，可以再试一次')
        }
        await updateChat(chat.id, function (current) {
          if (current?.regenRecovery?.id !== operationId) throw new Error('重新生成操作已失效')
          const messages = Array.isArray(current.messages) ? current.messages : []
          if (messages.length >= rolledMessageCount + 2) return
          current.messages = messages.concat(partialAttemptRows({ turn: syntheticTurn, userText: syntheticText,
            inputAttachments: msgs0[oldAssistantIndex - 1].inputAttachments, text: streamed }))
          // The host's own commit for this turn must not append the round twice if
          // its stop hook lands after this write; the commit drops this record.
          current.nativeCommits = current.nativeCommits !== null && typeof current.nativeCommits === 'object' ? current.nativeCommits : {}
          current.nativeCommits[String(syntheticTurn)] = { turn: syntheticTurn, userText: syntheticText, committedAt: Date.now(), partial: true }
          return current
        }, { source: 'foreground.regen-partial' })
        latest = await readChat(chat.id)
        if (latest === undefined) throw new Error('聊天不存在: ' + chat.id)
        latestMsgs = latest.messages || []
        keptPartial = true
      }
      const regeneratedUser = latestMsgs[latestMsgs.length - 2]
      const newAssistant = latestMsgs[latestMsgs.length - 1]
      if (regeneratedUser === null || typeof regeneratedUser !== 'object' || regeneratedUser.role !== 'user' ||
          newAssistant === null || typeof newAssistant !== 'object' || newAssistant.role !== 'assistant' || Number(newAssistant.turn) !== syntheticTurn) {
        throw new Error('重新生成流程未产生正文')
      }
      keptPartial ||= newAssistant.incomplete === true || incompleteGeneration(session, syntheticTurn, eventStart)
      if (keptPartial) {
        newAssistant.incomplete = true
        newAssistant.incompleteReason ||= '这次重新生成未完成，保留了已生成的部分正文'
      }
      body = str(newAssistant.text).trim()
      if (body === '') {
        throw new Error('重新生成失败：模型返回空文本')
      }
      // The persisted intent must only reference events already on disk.
      if (typeof sessions.flush === 'function') await sessions.flush(session)
      let projection = null
      committedChat = await updateChat(latest.id, function (current) {
        if (current?.regenRecovery?.id !== operationId) throw new Error('重新生成操作已失效')
        const currentMessages = Array.isArray(current && current.messages) ? current.messages : []
        const currentUser = currentMessages[currentMessages.length - 2]
        const currentAssistant = currentMessages[currentMessages.length - 1]
        if (currentMessages.length < rolledMessageCount + 2 || currentUser === null || typeof currentUser !== 'object' || currentUser.role !== 'user' ||
            currentAssistant === null || typeof currentAssistant !== 'object' || currentAssistant.role !== 'assistant' || Number(currentAssistant.turn) !== syntheticTurn) throw new Error('重新生成流程的正文已被另一项操作修改')
        // 失败轮清理可能重新投影同一尝试；提交时以当前行的正文为准。
        body = str(currentAssistant.text).trim()
        if (body === '') throw new Error('重新生成失败：模型返回空文本')
        keptPartial ||= currentAssistant.incomplete === true
        if (keptPartial) {
          currentAssistant.incomplete = true
          currentAssistant.incompleteReason ||= newAssistant.incompleteReason || '这次重新生成未完成，保留了已生成的部分正文'
        }
        projection = placeRegeneration(session, oldSeq, eventStart, { turn: oldTurn, step: 1, message: { id: 'tavern-regen:' + operationId,
          role: 'assistant', content: [{ type: 'text', text: body }], source: regeneratedSource(oldSource, oldTurn, syntheticTurn, keptPartial, currentAssistant.incompleteReason) } }, operationId)
        const merged = replaceLastRound({ originalChat, regeneratedChat: current, assistantIndex: oldAssistantIndex })
        const next = merged.chat
        if (next.nativeCommits !== null && typeof next.nativeCommits === 'object') delete next.nativeCommits[String(syntheticTurn)]
        next.nativeCommits = next.nativeCommits && typeof next.nativeCommits === 'object' ? structuredClone(next.nativeCommits) : {}
        if (originalChat.nativeCommits && originalChat.nativeCommits[String(oldTurn)]) next.nativeCommits[String(oldTurn)] = structuredClone(originalChat.nativeCommits[String(oldTurn)])
        next.regenInProgress = true
        next.regenRecovery = { ...current.regenRecovery, phase: 'committed', projection }
        next.settleStatus = 'pending'
        next.settleError = null
        next.tavernHelperLifecycleRevision = lifecycleRevision + 1
        // 旧正文的临时隐藏留到投影写入时（regenerationRecovery.complete）才撤：此刻日志里还没有
        // 投影，行计划会把旧轮和生成轮都画出来，同一段正文显示两份（#312）。
        next.suppressedDshTurns = Array.from(new Set((Array.isArray(next.suppressedDshTurns) ? next.suppressedDshTurns : []).concat([syntheticTurn]))).sort(function (left, right) { return left - right })
        next.regeneratedDshTurns = next.regeneratedDshTurns && typeof next.regeneratedDshTurns === 'object' && !Array.isArray(next.regeneratedDshTurns)
          ? structuredClone(next.regeneratedDshTurns) : {}
        next.regeneratedDshTurns[String(oldTurn)] = syntheticTurn
        return next
      }, { source: 'foreground.regen-commit' })
    } catch (error) {
      await restoreFailedRegen()
      throw error
    }
    committedChat = await regenerationRecovery.complete({ chatId: chat.id, session, operationId }) || committedChat
    replyCommitted?.(committedChat.sessionId)
    let settledChat = committedChat
    try {
      await queueSettlement(committedChat.id)
      settledChat = await readChat(committedChat.id) || committedChat
    } catch (error) {
      const message = str(error?.message || error) || '后台结算失败'
      settledChat = await updateChat(committedChat.id, function (current) {
        if (!current || typeof current !== 'object') return current
        current.settleStatus = 'failed'
        current.settleError = message
        return current
      }, { source: 'settlement.regen-failed' })
    }
    const result = await view(settledChat, card)
    result.adopted = { text: body, guidance: guide, hiddenTurn: oldTurn, syntheticTurn: syntheticTurn }
    if (keptPartial) result.regenerationWarning = '这次重新生成没有完成（可能被内容审核拦截或已停止），已保留生成到的部分正文。'
    return result
  }

  // Native saves regenerate from their recent floors. The temporary rollback and
  // the final commit are revision-checked patches: floors changed since the
  // checkpoint are restored for generation, then every floor changed since the
  // original revision returns to its original value around the new round, as
  // replaceLastRound would build it. Undefined (before any visible effect) leaves
  // legacy checkpoints and unreadable revisions to the complete path.
  async function regenRecent(chatId, guidance, sessionId) {
    if (sessionPatch && !sessionPatch.replacementAllowed()) throw new Error(sessionPatch.blockReason())
    if (![chats.readRecent, chats.patch, chats.changedSince, chats.rowsAt].every(fn => typeof fn === 'function')) return undefined
    let chat = await chats.readRecent(chatId)
    if (!chat || !isScopedMessages(chat.messages)) return undefined
    assertRescueHistoryEditable(chat)
    const { messages: _rows, ...originalHeader } = chat
    const target = storyTimeline.rollbackTarget({ chat: { ...originalHeader, messages: [] } })
    if (target === null) return undefined
    const revision = chat._storageRevision
    const sinceCheckpoint = await chats.changedSince(chat.id, target.beforeRevision)
    if (!sinceCheckpoint || sinceCheckpoint.revision !== revision) return undefined
    const checkpointHead = await chats.rowsAt(chat.id, target.beforeRevision, [])
    if (!checkpointHead || checkpointHead.chat._storageRevision !== target.beforeRevision || checkpointHead.messageCount > chat.messages.length) return undefined
    const rolledMessageCount = checkpointHead.messageCount
    const checkpointIndices = sinceCheckpoint.indices.filter(index => index < rolledMessageCount)
    const checkpointRows = checkpointIndices.length ? await chats.rowsAt(chat.id, target.beforeRevision, checkpointIndices) : { chat: checkpointHead.chat, denseMessages: true }
    if (!checkpointRows?.denseMessages) return undefined
    const activeRound = Object.values(storyTimeline.inspect({ chat: originalHeader }).operations || {}).find(function (operation) {
      return operation && operation.kind === 'body' && operation.status === 'completed' &&
        operation.background && ['pending', 'running'].includes(str(operation.background.phase))
    })
    if (chat.regenInProgress === true) throw new Error('正文正在重新生成，请等待完成')
    const card = await readChatCard(chat)
    const storedSessionId = chat.sessionId
    if (typeof sessionId === 'string' && sessionId !== '') chat.sessionId = sessionId
    if (typeof chat.sessionId !== 'string' || chat.sessionId === '') throw new Error('会话未绑定 DSH 会话')
    const agent = sessions.get(chat.sessionId)
    if (agent === undefined || agent.session === undefined) throw new Error('无法访问 DSH 会话: ' + chat.sessionId)
    if (agent.phase?.kind === 'running') throw new Error('前台正在生成，请完成或停止后再重新生成')
    const session = agent.session
    let selection, evidence
    try { selection = await selectRepairedTarget(chat, session, diagnostics ? value => { evidence = value } : undefined) }
    finally {
      if (evidence) {
        try { await diagnostics.record(chat.sessionId, { stage: 'regeneration-target', diagnosticId: randomUUID(),
          outcome: evidence.reason === 'selected' ? 'selected' : 'rejected', ...evidence,
          guidanceProvided: typeof guidance === 'string' && guidance.trim().length > 0,
          binding: { requested: diagnosticIdentity(sessionId), stored: diagnosticIdentity(storedSessionId), effective: diagnosticIdentity(chat.sessionId),
            overridden: Boolean(sessionId && sessionId !== storedSessionId) },
          agent: { phase: ['running', 'idle'].includes(agent.phase?.kind) ? agent.phase.kind : 'other', lastTurn: Number.isFinite(agent.phase?.lastTurn) ? agent.phase.lastTurn : null } }) }
        catch { /* Recording failure must not affect regeneration or replace its error. */ }
      }
    }
    const { eventStart, msgs0, oldAssistantIndex, oldSeq, oldTurn, oldSource } = selection
    if (!Object.hasOwn(msgs0, String(oldAssistantIndex - 1))) throw new Error('没有可重新生成的玩家输入与正文组合')
    if (session.header?.version >= 3) {
      const preview = session.constructor.fromRestore(session.id, structuredClone(sessionEvents(session)), structuredClone(session.header), session.inheritedEventCount, 'detached')
      try {
        replaceSessionSurface(preview, 'assistant/message', {
          turn: oldTurn, step: 1,
          message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: msgs0[oldAssistantIndex].text }], source: oldSource }
        }, { start: oldSeq, end: oldSeq, sourceEventSeqs: [oldSeq] })
      } catch (error) {
        if (sessionPatch?.status === 'failed') throw new Error(sessionPatch.reason, { cause: error })
        if (sessionPatch?.serverReady) throw error
        throw new Error('当前 DSH 不支持正文替换，未启动重新生成。' + str(error?.message || error), { cause: error })
      }
    }
    const originalUser = structuredClone(msgs0[oldAssistantIndex - 1])
    const originalAssistant = structuredClone(msgs0[oldAssistantIndex])
    const originalUserText = str(originalUser.text).trim()
    const operationId = randomUUID()
    const lifecycleRevision = Math.max(0, Number(originalHeader.tavernHelperLifecycleRevision) || 0) + 1
    const headerChanges = (before, after) => diffJson({ ...before, messages: [] }, { ...after, messages: [] })
      .filter(change => !['_storageRevision', 'updatedAt'].includes(change.path[0]))
    // 1) The checkpoint state, marked as a recoverable regeneration.
    const { messages: _checkpointRows, ...checkpointHeader } = checkpointRows.chat
    const rolled = storyTimeline.apply({ chat: { ...originalHeader, messages: [] }, intent: { kind: 'turn.rollback', turn: oldTurn, beforeChat: { ...checkpointHeader, messages: [] } } }).chat
    rolled.regenRecovery = { id: operationId, beforeRevision: revision, sessionId: chat.sessionId, eventStart }
    rolled.tavernHelperLifecycleRevision = lifecycleRevision
    rolled.regenInProgress = true
    // 同上（完整路径）：生成期间只藏被重做的旧正文，玩家输入留着。
    const rolledReplacingBefore = Array.isArray(rolled.replacingDshTurns) ? rolled.replacingDshTurns : []
    const rolledAlreadyReplacing = rolledReplacingBefore.some(function (turn) { return Number(turn) === Number(oldTurn) })
    rolled.regenRecovery.temporaryReplacingTurn = rolledAlreadyReplacing ? null : oldTurn
    if (!rolledAlreadyReplacing) rolled.replacingDshTurns = Array.from(new Set(rolledReplacingBefore.concat([oldTurn]))).sort(function (left, right) { return left - right })
    const rollbackChanges = headerChanges(originalHeader, rolled)
    if (rollbackChanges.some(change => change.path[0] === 'messages' || change.path[0] === 'id')) return undefined
    if (msgs0.length > rolledMessageCount) rollbackChanges.push({ op: 'splice', path: ['messages'], index: rolledMessageCount, deleteCount: msgs0.length - rolledMessageCount, items: [] })
    checkpointIndices.forEach((index, offset) => rollbackChanges.push({ op: 'set', path: ['messages', index], value: checkpointRows.chat.messages[offset] }))
    if (agent.phase?.kind === 'running') throw new Error('前台正在生成，请完成或停止后再重新生成')
    const rolledSaved = await chats.patch(chat.id, revision, rollbackChanges, { source: 'rollback.regen' })
    if (!rolledSaved) return undefined
    async function restoreFailedRegen() {
      // Rare error path: the complete abort restores the exact original revision.
      const originalChat = await readChatRevision(chat.id, revision)
      await regenerationRecovery.abort({ chatId: chat.id, originalChat, session, eventStart, operationId })
    }
    const guide = str(guidance).trim()
    const syntheticText = regenerationInputText(originalUserText, guide, replyTextOf(msgs0[oldAssistantIndex]))
    releaseOpeningTurn(agent.session, agent)
    const beforeLastTurn = agent.phase !== undefined && agent.phase !== null && Number.isFinite(Number(agent.phase.lastTurn)) ? Number(agent.phase.lastTurn) : 0
    let committedChat, body, syntheticTurn, keptPartial = false
    try {
      if (activeRound !== undefined && typeof cancelSettlement === 'function') await cancelSettlement(chat.id)
      if (agent.phase?.kind === 'running') throw new Error('前台正在生成，未启动重新生成')
      const ready = await chats.readRecent(chat.id)
      if (ready?.regenRecovery?.id !== operationId || agent.phase?.kind === 'running') throw new Error('重新生成操作已失效或前台正在生成')
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: projectPlayerContent(originalUser.inputAttachments, syntheticText),
        source: { kind: 'plugin:dsh-tavern-regen', regenerationId: operationId }
      })
      // 同上（完整路径）：中断的尝试仍把已生成的正文留在日志里，接着用它。
      let generationError = null
      try { await agent.whenIdle() } catch (error) { generationError = error }
      syntheticTurn = agent.phase !== undefined && agent.phase !== null && Number.isFinite(Number(agent.phase.lastTurn)) ? Number(agent.phase.lastTurn) : (beforeLastTurn + 1)
      let latest = await chats.readRecent(chat.id)
      if (latest === undefined) throw new Error('聊天不存在: ' + chat.id)
      let latestMsgs = latest.messages
      let adoptedPartial = false
      if (latestMsgs.length < rolledMessageCount + 2) {
        const streamed = streamedAttemptText(session, syntheticTurn, eventStart)
        if (streamed === '') {
          if (generationError !== null) throw generationError
          throw new Error('这次重新生成没有完成（可能被内容审核拦截或已停止），正文保持原样，可以再试一次')
        }
        // 被截断的尝试写进存档之后，宿主和插件的失败轮清理还会各写一次（例如
        // 还原 promptTemplateInput）。用读到的 revision 只写一次就作废，会把刚
        // 保留下的部分正文连同整轮一起撤回——所以拿最新 revision 重试。
        for (let attempt = 0; attempt < REGEN_WRITE_ATTEMPTS && !adoptedPartial; attempt++) {
          const commits = latest.nativeCommits !== null && typeof latest.nativeCommits === 'object' ? structuredClone(latest.nativeCommits) : {}
          // 同上（完整路径）：宿主自己的提交若随后到达，不能把这一轮再追加一次。
          const partialCommit = { turn: syntheticTurn, userText: syntheticText, committedAt: Date.now(), partial: true }
          const written = await chats.patch(chat.id, latest._storageRevision, [{ op: 'splice', path: ['messages'], index: latestMsgs.length, deleteCount: 0,
            items: partialAttemptRows({ turn: syntheticTurn, userText: syntheticText, inputAttachments: originalUser.inputAttachments, text: streamed }) },
          { op: 'set', path: ['nativeCommits'], value: { ...commits, [String(syntheticTurn)]: partialCommit } }],
          { source: 'foreground.regen-partial' })
          latest = await chats.readRecent(chat.id)
          if (latest === undefined) throw new Error('聊天不存在: ' + chat.id)
          if (latest.regenRecovery?.id !== operationId) throw new Error('重新生成操作已失效')
          latestMsgs = latest.messages
          adoptedPartial = Boolean(written)
          // 宿主自己把这一轮提交上来了：用它，不再追加。
          if (!adoptedPartial && latestMsgs.length >= rolledMessageCount + 2) break
        }
        if (!adoptedPartial && latestMsgs.length < rolledMessageCount + 2) throw new Error('重新生成流程的正文已被另一项操作修改')
        keptPartial = adoptedPartial
      }
      // 2) The original floors around the new round. Floors changed since the
      // original revision (the temporary rollback included) return to it.
      let committed = null
      for (let attempt = 0; attempt < REGEN_WRITE_ATTEMPTS && committed === null; attempt++) {
        if (attempt > 0) {
          latest = await chats.readRecent(chat.id)
          if (latest === undefined) throw new Error('聊天不存在: ' + chat.id)
          latestMsgs = latest.messages
        }
        if (latest.regenRecovery?.id !== operationId) throw new Error('重新生成操作已失效')
        const regeneratedUser = latestMsgs[latestMsgs.length - 2]
        const newAssistant = latestMsgs[latestMsgs.length - 1]
        if (regeneratedUser === null || typeof regeneratedUser !== 'object' || regeneratedUser.role !== 'user' ||
            newAssistant === null || typeof newAssistant !== 'object' || newAssistant.role !== 'assistant' || Number(newAssistant.turn) !== syntheticTurn) {
          throw new Error('重新生成流程未产生正文')
        }
        // 与完整路径同理：这一轮的行就是事实，重算投影时用它的正文。
        keptPartial ||= newAssistant.incomplete === true || incompleteGeneration(session, syntheticTurn, eventStart)
        if (keptPartial) {
          newAssistant.incomplete = true
          newAssistant.incompleteReason ||= '这次重新生成未完成，保留了已生成的部分正文'
        }
        body = str(newAssistant.text).trim()
        if (body === '') throw new Error('重新生成失败：模型返回空文本')
        const projection = placeRegeneration(session, oldSeq, eventStart, { turn: oldTurn, step: 1, message: { id: 'tavern-regen:' + operationId,
          role: 'assistant', content: [{ type: 'text', text: body }], source: regeneratedSource(oldSource, oldTurn, syntheticTurn, keptPartial, newAssistant.incompleteReason) } }, operationId)
        if (typeof sessions.flush === 'function') await sessions.flush(session)
        const { messages: _latestRows, ...latestHeader } = latest
        const merged = replaceLastRound({ originalChat: { messages: [originalUser, originalAssistant] }, regeneratedChat: { ...latestHeader, messages: [regeneratedUser, newAssistant] }, assistantIndex: 1 })
        const next = merged.chat
        if (next.nativeCommits !== null && typeof next.nativeCommits === 'object') delete next.nativeCommits[String(syntheticTurn)]
        next.nativeCommits = next.nativeCommits && typeof next.nativeCommits === 'object' ? structuredClone(next.nativeCommits) : {}
        if (originalHeader.nativeCommits && originalHeader.nativeCommits[String(oldTurn)]) next.nativeCommits[String(oldTurn)] = structuredClone(originalHeader.nativeCommits[String(oldTurn)])
        next.regenInProgress = true
        next.regenRecovery = { ...latest.regenRecovery, phase: 'committed', projection }
        next.settleStatus = 'pending'
        next.settleError = null
        next.tavernHelperLifecycleRevision = lifecycleRevision + 1
        // 旧正文的临时隐藏留到投影写入时（regenerationRecovery.complete）才撤：此刻日志里还没有
        // 投影，行计划会把旧轮和生成轮都画出来，同一段正文显示两份（#312）。
        next.suppressedDshTurns = Array.from(new Set((Array.isArray(next.suppressedDshTurns) ? next.suppressedDshTurns : []).concat([syntheticTurn]))).sort(function (left, right) { return left - right })
        next.regeneratedDshTurns = next.regeneratedDshTurns && typeof next.regeneratedDshTurns === 'object' && !Array.isArray(next.regeneratedDshTurns)
          ? structuredClone(next.regeneratedDshTurns) : {}
        next.regeneratedDshTurns[String(oldTurn)] = syntheticTurn
        const prefix = oldAssistantIndex - 1
        const sinceOriginal = await chats.changedSince(chat.id, revision)
        if (!sinceOriginal || sinceOriginal.revision !== latest._storageRevision) continue
        const restoreIndices = sinceOriginal.indices.filter(index => index < prefix)
        const originalRows = restoreIndices.length ? await chats.rowsAt(chat.id, revision, restoreIndices) : { chat: {}, denseMessages: true }
        if (!originalRows?.denseMessages) throw new Error('找不到重新生成前的存档恢复点')
        const commitChanges = headerChanges(latestHeader, next)
        restoreIndices.forEach((index, offset) => commitChanges.push({ op: 'set', path: ['messages', index], value: originalRows.chat.messages[offset] }))
        commitChanges.push({ op: 'splice', path: ['messages'], index: prefix, deleteCount: latestMsgs.length - prefix, items: merged.chat.messages })
        const saved = await chats.patch(chat.id, latest._storageRevision, commitChanges, { source: 'foreground.regen-commit' })
        if (!saved) continue
        committed = { ...next, _storageRevision: saved._storageRevision, updatedAt: saved.updatedAt, messages: createScopedMessages(prefix + 2) }
      }
      if (committed === null) throw new Error('重新生成流程的正文已被另一项操作修改')
      committedChat = committed
    } catch (error) {
      await restoreFailedRegen()
      throw error
    }
    committedChat = await completeRecent(committedChat, session, operationId)
    replyCommitted?.(committedChat.sessionId)
    let settledChat = committedChat
    try {
      await queueSettlement(committedChat.id)
    } catch (error) {
      const message = str(error?.message || error) || '后台结算失败'
      settledChat = await updateChat(committedChat.id, function (current) {
        if (!current || typeof current !== 'object') return current
        current.settleStatus = 'failed'
        current.settleError = message
        return current
      }, { source: 'settlement.regen-failed' })
    }
    const result = await view(settledChat, card)
    result.adopted = { text: body, guidance: guide, hiddenTurn: oldTurn, syntheticTurn: syntheticTurn }
    if (keptPartial) result.regenerationWarning = '这次重新生成没有完成（可能被内容审核拦截或已停止），已保留生成到的部分正文。'
    return result
  }

  // Project the committed body onto the native surface, then clear the recovery
  // marker with a header patch. A moved revision uses the complete completion.
  async function completeRecent(chat, session, operationId) {
    const saved = chat.regenRecovery
    if (saved?.phase !== 'committed' || saved.id !== operationId || saved.sessionId !== session.id || !saved.projection || saved.projection.unplaced) {
      return await regenerationRecovery.complete({ chatId: chat.id, session, operationId }) || chat
    }
    try {
      applyRegenerationProjection(session, saved.projection)
      if (typeof sessions.flush === 'function') await sessions.flush(session)
    } catch {
      // The complete completion retries once, then ends the marker and repairs from the save.
      return await regenerationRecovery.complete({ chatId: chat.id, session, operationId }) || chat
    }
    const replacing = projectedReplacingTurns(chat)
    const head = await chats.patch(chat.id, chat._storageRevision, [{ op: 'delete', path: ['regenRecovery'] }, { op: 'delete', path: ['regenInProgress'] },
      replacing ? { op: 'set', path: ['replacingDshTurns'], value: replacing } : { op: 'delete', path: ['replacingDshTurns'] }], { source: 'foreground.regen-projected' })
    if (head) {
      const { regenRecovery: _recovery, regenInProgress: _flag, replacingDshTurns: _replacing, ...rest } = chat
      return { ...rest, ...(replacing ? { replacingDshTurns: replacing } : {}), _storageRevision: head._storageRevision, updatedAt: head.updatedAt }
    }
    return await regenerationRecovery.complete({ chatId: chat.id, session, operationId }) || chat
  }

  return { regenBody, regenRecent }
}
