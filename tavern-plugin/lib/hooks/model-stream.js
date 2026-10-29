import { observeStageText } from '../domain/stage-director-stream.js'
import { createImportContextPreparation } from '../domain/import-context-preparation.js'
import { createStoryCompactionRequest, nativelyRetainedRounds, retainRecentStoryRounds, storyVolumeMerge, storyVolumePlan, usesStoryCompaction } from '../domain/story-compaction.js'
import { installCompactionRequestProjection } from '../domain/compaction-request.js'
import { installWorkspaceInstructionPresentation } from '../domain/workspace-instruction-presentation.js'
import { presentModelError } from '../domain/model-error-presentation.js'
import { markRequestHandled, requestHandledBy } from '../domain/request-lineage.js'

export function registerModelStreamHooks({
  agentRegistry,
  backgroundAgentRunner,
  chatForSession,
  chatHeaderForSession,
  ctx,
  foregroundStrategies,
  fullTemplateRuntime,
  modelRequestLog,
  pluginCompactionNotes,
  pluginSettlementProgress,
  stageDirectorStream,
  replyStarted,
  requestCoordinates,
  storyRetention,
  runtimePrompt,
  sessionStateForSession,
  recentStateForSession,
  sessionStore,
  str,
  updateChat,
  worldbookRecallLog,
}) {
  const importContextPreparation = createImportContextPreparation({
    readChat: chatForSession, readHeader: chatHeaderForSession, updateChat,
    getSession: id => sessionStore.get(id) || agentRegistry.get(id)?.session,
    flush: session => sessionStore.flush(session),
    modelInfo: request => ctx.llm.resolveModelInfo(request.provider, request.model, request.signal),
    estimateMessage: message => {
      const meter = ctx.get('tokenMeter')
      if (!meter?.estimateMessage) throw new Error('当前宿主缺少原生 token 计量接口，请更新 DSH 后重试')
      const native = meter.estimateMessage(message)
      // The host's fixed four-characters/token estimate underprices CJK text.
      // Use a conservative Unicode floor for this one-time admission check.
      const text = (message.content || []).map(block => block.text || JSON.stringify(block)).join('')
      const nonAscii = [...text].filter(char => char.codePointAt(0) > 127).length
      return Math.max(native, Math.ceil((text.length - nonAscii) / 4) + nonAscii * 2 + 8)
    }
  })
  // Whether a session is a Tavern game: its header answers that, not its history.
  const isGame = async sessionId => Boolean(await chatHeaderForSession(str(sessionId), []))
  installWorkspaceInstructionPresentation(ctx, async sessionId => {
    if (backgroundAgentRunner.owns(sessionId)) return true
    return isGame(sessionId)
  })
  installCompactionRequestProjection(ctx, async sessionId => backgroundAgentRunner.owns(sessionId) || await isGame(sessionId), async request => {
    // Story/script chats summarize with the story prompt and keep the latest rounds
    // verbatim after the summary; other sessions keep DSH's prompt.
    const head = await chatHeaderForSession(str(request.sessionId), [])
    if (!usesStoryCompaction(head)) return { request }
    // An imported game compacts right away: an oversized history is summarized in segments
    // (bounded-compaction.js), so the first-play capacity check is not a precondition.
    // Seam to the plugin layer: plugins may add what the summary must keep.
    const notes = pluginCompactionNotes ? await pluginCompactionNotes({ gameId: str(request.sessionId) }).catch(() => []) : []
    const session = sessionStore.get(request.sessionId) || agentRegistry.get(request.sessionId)?.session
    const retention = await storyRetention(request)
    const natively = nativelyRetainedRounds(session, request)
    // Which story turns this compaction folds: everything but the rounds kept verbatim.
    const kept = retainRecentStoryRounds(request, retention.rounds - natively, retention).kept || 0
    // The turn the summary folds through is a few rounds from the end: the latest floors
    // hold it; the whole history only where storage cannot read those alone.
    const back = kept + natively
    const recent = await recentStateForSession(str(request.sessionId), 2 * back + 8)
    const recentTurns = (recent?.messages || []).filter(message => message?.role === 'assistant' && Number(message.turn) > 0).map(message => Number(message.turn))
    const turns = recent && (recent.messagesFrom === 0 || recentTurns.length > back) ? recentTurns
      : ((await chatForSession(str(request.sessionId)))?.messages || []).filter(message => message?.role === 'assistant' && Number(message.turn) > 0).map(message => Number(message.turn))
    const volumes = storyVolumePlan(request, { through: turns[turns.length - 1 - kept - natively], budget: retention.volumeBudget, estimate: retention.estimate })
    const instruction = [runtimePrompt('story-compaction'), volumes.instruction, ...(notes.length ? ['【插件附加的摘要要求】', ...notes.map(note => note.text)] : [])].join('\n\n')
    const story = createStoryCompactionRequest(request, instruction)
    let prefix = volumes.prefix
    if (volumes.merge) {
      // Only the oldest volumes are rewritten, in their own call; a failed merge keeps them all.
      try { prefix = [prefix[0], await mergeStoryVolumes(volumes.merge, request), ...prefix.slice(1)] }
      catch (error) {
        console.warn('dsh-tavern: 合并旧卷失败，本次原样保留全部旧卷：', error?.message || error)
        prefix = [prefix[0], ...volumes.merge.volumes.map(volume => volume.text), ...prefix.slice(1)]
      }
    }
    return { ...retainRecentStoryRounds(story, retention.rounds - natively, retention), prefix }
  })
  async function mergeStoryVolumes(merge, request) {
    const { header, prompt } = storyVolumeMerge(merge)
    let text = ''
    for await (const event of ctx.llm.stream({ provider: request.provider, model: request.model, purpose: 'compaction', signal: request.signal,
      ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
      messages: [{ id: 'tavern-story-volume-merge', role: 'user', content: [{ type: 'text', text: prompt }] }] })) {
      if (event?.type === 'block-end' && event.block?.type === 'text') text += event.block.text
      if (event?.type === 'finish' && event.reason?.kind !== 'stop') throw new Error('合并未完成：' + (event.reason?.failure?.message || event.reason?.kind))
    }
    text = text.trim()
    if (!text) throw new Error('合并没有返回文字')
    return text.startsWith('【前情总览') ? text : header + '\n' + text
  }

  async function gameChildSession(sessionId) {
    const parentSessionId = str((sessionStore.get(sessionId) || agentRegistry.get(sessionId)?.session)?.header?.parentSession)
    if (!parentSessionId || parentSessionId === sessionId || backgroundAgentRunner.owns(parentSessionId)) return null
    const chat = await chatHeaderForSession(parentSessionId, ['requestMode', 'compatibilityTraces', 'bypassPlanId', 'runtimePresetSnapshot'])
    if (!chat || !['story', 'script'].includes(chat.mode)) return null
    // The request carries no turn; file it under the game's latest turn so old bodies are pruned with the rest.
    const turn = (await modelRequestLog.list(chat.id)).reduce((latest, entry) => Math.max(latest, Number(entry.turn) || 0), 0)
    return { chat, context: { scope: 'background', task: 'subagent', parentSessionId, turn } }
  }
  ctx.on('llm/stream', function (options, next) {
    const sessionId = str(options && options.sessionId)
    const coordinates = requestCoordinates.get(sessionId)
    if (coordinates !== undefined) {
      requestCoordinates.set(sessionId, Object.assign({}, coordinates, {
        source: { kind: 'model', provider: str(options.provider), model: str(options.model) }
      }))
    }
    const projectedRequest = (requestHandledBy(options, 'full-template') || importContextPreparation.isPrepared(options)) ? null : foregroundStrategies.projectRequest(options, coordinates)
    if (projectedRequest !== null) return ctx.llm.stream(projectedRequest)
    const stream = next()
    const backgroundContext = backgroundAgentRunner.requestContext(sessionId)
    const ownerSessionId = backgroundContext ? backgroundContext.parentSessionId : sessionId
    return (async function * () {
      const prepared = await importContextPreparation.prepare(options)
      if (prepared !== options) { yield * ctx.llm.stream(prepared); return }
      const chat = ownerSessionId === '' ? undefined : await chatHeaderForSession(ownerSessionId, [
        'requestMode', 'compatibilityTraces', 'bypassPlanId', 'runtimePresetSnapshot', 'foregroundFrames'
      ])
      if (chat && ['story', 'script'].includes(chat.mode) && options.purpose === undefined && chat.requestMode !== 'sillytavern' && !requestHandledBy(options, 'full-template')) {
        const projected = await fullTemplateRuntime.forSession(ownerSessionId).projectRequestProjection({ messages: options.messages, system: options.system, model: options.model })
        yield * ctx.llm.stream(markRequestHandled({ ...options, ...projected }, 'full-template'))
        return
      }
      let requestRecord = null
      // Agents a plugin creates under a game are not Tavern's own sessions; log them
      // as that game's background requests so 完整上下文 can show them.
      const child = options.purpose === undefined && !backgroundContext && !chat ? await gameChildSession(sessionId) : null
      if (child) requestRecord = await modelRequestLog.record({ chat: child.chat, context: child.context, coordinates: {}, options })
      else if (options.purpose === undefined && chat !== undefined && ['story', 'script', 'card'].includes(chat.mode)) {
        const coordinates = requestCoordinates.get(sessionId) || {}
        requestRecord = await modelRequestLog.record({ chat, context: backgroundContext, coordinates, options })
        if (!backgroundContext && ['story', 'script'].includes(chat.mode)) {
          // Evidence only: scanning a multi-MB request must not delay the first token.
          worldbookRecallLog.requested(chat, options, requestRecord.id)
            .catch(error => console.warn('dsh-tavern: 世界书请求日志关联失败', String(error?.message || error)))
        }
      }
      const progress = child ? event => pluginSettlementProgress?.model(child.context.parentSessionId, event) : () => {}
      progress('start')
      // The story reply of a turn started streaming (正文开始; once per turn, see index.js).
      if (!backgroundContext && !child && options.purpose === undefined && ['story', 'script'].includes(chat?.mode)) replyStarted?.(sessionId, requestCoordinates.get(sessionId)?.turn)
      const stage = stageDirectorStream && !backgroundContext && !child && options.purpose === undefined && ['story', 'script'].includes(chat?.mode)
        ? observeStageText({ begin: () => stageDirectorStream.begin(sessionId, coordinates?.turn), signal: options.signal,
          warn: error => console.warn('dsh-tavern: 舞台流已停止', str(error?.message || error)) }) : null
      let responseText = ''
      const blockTypes = new Map()
      let finish = null
      let failure = null
      try {
        for await (const chunk of stream) {
          if (chunk?.type === 'block-start') blockTypes.set(chunk.index, chunk.blockType)
          if (chunk && chunk.type === 'text-delta') {
            responseText += str(chunk.text)
            if (!blockTypes.has(chunk.index) || blockTypes.get(chunk.index) === 'text') stage?.append(str(chunk.text))
          }
          if (chunk && ['text-delta', 'reasoning-delta', 'tool-call-delta'].includes(chunk.type)) progress('output')
          if (chunk && chunk.type === 'finish') finish = chunk.reason === undefined ? chunk : chunk.reason
          yield chunk
        }
      } catch (error) {
        const displayedError = chat ? presentModelError(error) : error
        failure = str(displayedError && displayedError.message || displayedError)
        throw displayedError
      } finally {
        progress('end')
        const completed = finish && finish.kind !== 'error' && finish.kind !== 'aborted'
        void stage?.finish(completed && !failure)
        foregroundStrategies.completeRequest(options, completed)
        const owner = child ? child.chat : chat
        if (owner && requestRecord) {
          try { await modelRequestLog.complete({ chatId: owner.id, id: requestRecord.id, text: responseText, finish, error: failure }) }
          catch (error) { console.error('dsh-tavern: 模型结果日志写入失败', str(error && error.message || error)) }
        }
      }
    })()
  }, { global: true })
}
