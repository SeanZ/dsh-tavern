import { setAllFailedErrorVisibility, setFailedErrorVisibility } from '../domain/failed-error-visibility.js'
import { sessionEvents } from '../domain/session-events.js'
import { applyPolishEdits, buildPolishReviewRequest, parsePolishReview, polishReviewContext } from '../domain/polish-review.js'
import { randomUUID } from 'node:crypto'

// In-game play, turn editing, compaction and background settlement requests.
// `deps` carries the services ../index.js builds; dispatchMethod routes by method name.
export function createPlayHandlers(deps) {
  const { agentCompaction, agentRegistry, backgroundAgentRunner, backgroundCatalog, bodyEditor, callModel, polishRecords, chatHeaderWithLatestFloors, applyCardUpdate, cardAutoReload,
    candidateGenerator, candidateTasks, chatForSession, compactionAbort, conversationGuides, ctx,
    ledgerEditor, manualCharacterDesign, manualLedger, notifyPluginTimeline, phoneChat,
    pluginSettlementProgress, readBackgroundSuppression, readCard,
    reconcileStory, reconcileWhenIdle, regenBody, replayFailedTurn, requestPerformance, retrySettlement,
    retryStyleReference, rollbackTurn, rollbackToTurn, runtimeGeneration, runtimePrompt, sessionActivity, sessionOperation,
    sessionStateForSession, sessionStore, sessionView, sessionViews, setPlayerName, stopBackground, str,
    templateHistoryFrom, undoRollbackTurn, updateChat, view, withCompactionSession } = deps
  return {
    // For tools: send a player input as the page does; the turn runs like any other.
    async sendPlayerInput(args) {
      const sessionId = str(args?.sessionId), text = str(args?.text).trim()
      if (!sessionId || !text) throw new Error('缺少会话或输入内容')
      const requestId = randomUUID()
      await ctx.get('sessionController').prompt({ sessionId, requestId, content: [{ type: 'text', text }], mode: 'followup' }, new AbortController().signal)
      return { requestId }
    },
    async getBackgroundSuppressedTurns(args) {
      const id = str(args && args.sessionId)
      if (!id.startsWith('background-')) return { turns: [] }
      return readBackgroundSuppression(id)
    },
    // A legacy save's manual synchronization, or the retry after an automatic reload failed.
    async applyUpdatedCard(args) {
      const sessionId = str(args && args.sessionId)
      cardAutoReload.retry(sessionId)
      return { view: await applyCardUpdate(sessionId, args && args.digest) }
    },
    async getSession(args) {
      // A save opened for the first time in this process is checked once, while nothing runs.
      await reconcileWhenIdle(args && args.sessionId, { once: true })
      void backgroundCatalog(str(args && args.sessionId))
      if(args?.fullView === true)templateHistoryFrom.set(args.sessionId,0)
      else if(Number.isSafeInteger(args?.historyFrom) && args.historyFrom >= 0)templateHistoryFrom.set(args.sessionId,args.historyFrom)
      return sessionViews.response(args || {})
    },
    async designCharacter(args) {
      return await manualCharacterDesign.start(args || {})
    },
    async removeCharacterDesign(args) {
      if (agentRegistry.get(str(args?.sessionId))?.phase?.kind === 'running') throw new Error('前台正在生成，请完成后再删除人物档案。')
      return await manualCharacterDesign.remove(args || {})
    },
    async consolidateLedger(args) {
      return await manualLedger.start(args || {})
    },
    async sendPhoneMessage(args) {
      return { phoneChat: await phoneChat.send(args || {}) }
    },
    async runCompaction(args) {
      const id = str(args && args.sessionId), chat = await chatForSession(id)
      if (chat && ['story', 'script'].includes(chat.mode)) return { result: await deps.autoCompaction.run(id, { manual: true, signal: compactionAbort.signal }) }
      const result = await withCompactionSession(id, async agent => (await agentCompaction(agent)).compactNow(agent, compactionAbort.signal))
      return { result: { status: 'completed', foreground: { status: 'succeeded', message: result ? '压缩完成' : '没有可压缩的历史' }, background: { status: 'skipped' } } }
    },
    async dismissCompactionWarning(args) {
      const chat = await sessionStateForSession(str(args && args.sessionId))
      if (chat?.contextCompaction?.warning) await updateChat(chat.id, current => {
        current.contextCompaction = { ...current.contextCompaction, warning: '' }
        return current
      }, { source: 'compaction.dismiss' })
      return { dismissed: true }
    },
    async compactionStatus(args) {
      return { state: (await sessionStateForSession(args && args.sessionId))?.contextCompaction || null }
    },
    async syncSession(args) {
      const sync = await requestPerformance.stage('candidateSync', () => candidateTasks.sync(args && args.sessionId, { requestId: args && args.requestId, kind: args && args.kind }))
      requestPerformance.state({ foregroundRunning: agentRegistry.get(str(args?.sessionId))?.phase?.kind === 'running', backgroundBusy: sync.activity?.busy, backgroundRole: sync.activity?.role })
      return { sync }
    },
    async submitTask(args) {
      if (str(args && args.kind) !== 'candidate') throw new Error('暂不支持的持久任务类型: ' + str(args && args.kind))
      return { sync: await candidateTasks.submit(args) }
    },
    async getSessionActivity(args) {
      const agent = agentRegistry.get(str(args && args.sessionId))
      return { activity: await sessionActivity(args && args.sessionId), runtimeGeneration, liveSession: Boolean(agent && agent.session) }
    },
    async getBackgroundOperation(args) {
      return { operation: await sessionOperation(args && args.sessionId, args && args.operationId) }
    },
    async setStatusBarPlacement(args) {
      if (!['sidebar', 'body'].includes(args?.placement)) throw new Error('无效的状态栏位置')
      const chat = await chatForSession(args.sessionId)
      if (!chat || !['story', 'script'].includes(chat.mode || 'story')) throw new Error('请先打开游玩会话')
      await updateChat(chat.id, current => ({ ...current, statusBarPlacement: args.placement }), { source: 'ui.status-bar-placement' })
      return { statusBarPlacement: args.placement }
    },
    async setPlayerName(args) {
      return { playerName: await setPlayerName(args && args.sessionId, args && args.userName) }
    },
    async getChoices(args) {
      return { candidates: await candidateGenerator.find({ sessionId: args && args.sessionId, messageId: args && args.messageId }) }
    },
    async startChoices(args) {
      return await candidateTasks.startLegacy(args)
    },
    async editLedger(args) {
      await ledgerEditor(args || {})
      return { view: await sessionView(args.sessionId) }
    },
    async saveGuideLibrary(args) {
      return { item: await conversationGuides.save(args?.sessionId, args?.name) }
    },
    async loadGuideLibrary(args) {
      return { guides: await conversationGuides.load(args?.sessionId, args?.id) }
    },
    async addGuide(args) {
      return { guides: await conversationGuides.add(args?.sessionId, args?.text) }
    },
    async deleteGuide(args) {
      return { guides: await conversationGuides.remove(args?.sessionId, args) }
    },
    async getBodyEdit(args) {
      return { edit: args?.role === 'user' ? await bodyEditor.readUser(args && args.sessionId, args) : await bodyEditor.read(args && args.sessionId) }
    },
    async saveBodyEdit(args) {
      await reconcileStory(args && args.sessionId)
      if (args?.role === 'user') {
        const saved = await bodyEditor.saveUser(args && args.sessionId, args)
        if (saved && saved.detached === true) {
          // The failed turn is not in the model surface; withdraw it and give
          // the edited text back to the composer instead of rewriting history.
          const view = await rollbackTurn(args.sessionId, args.chatId, null)
          notifyPluginTimeline(args.sessionId, 'rollback', { turn: args.turn })
          return { view, composerText: saved.text }
        }
        notifyPluginTimeline(args.sessionId, 'edit', { settled: true })
        return { view: saved }
      }
      const view = await bodyEditor.save(args && args.sessionId, args)
      notifyPluginTimeline(args && args.sessionId, 'edit', { settled: true })
      return { view }
    },
    async retryStyleReference(args) {
      return { styleReference: await retryStyleReference(args?.sessionId, { target: 'next', guidance: args?.guidance }) }
    },
    // 精修: review the latest reply and apply every edit that still finds its text, as one body edit.
    // The texts before and after come back so the page can show the comparison and undo it.
    async polishBody(args) {
      const sessionId = str(args?.sessionId), started = Date.now()
      await reconcileStory(sessionId)
      const edit = await bodyEditor.read(sessionId)
      const texts = edit.parts.filter(part => part.kind === 'text').map(part => part.text)
      // The header and the last few floors are all a review reads: this turn's input and the reply before.
      const chat = await chatHeaderWithLatestFloors(sessionId, 4)
      const card = await readCard(chat.cardPath).catch(() => undefined) || chat.cardDefinitionSnapshot?.raw?.data || chat.cardDefinitionSnapshot?.raw
      const request = buildPolishReviewRequest({ principles: runtimePrompt('polish'), card, playerName: chat.macroState?.userName,
        ...polishReviewContext(chat.messages), reply: texts.join('\n\n'), guidance: args?.guidance })
      const review = parsePolishReview(await callModel({ sessionId, ...request }), texts)
      const chosen = review.edits.filter(item => item.status === 'ok')
      if (review.fallback || !chosen.length) return { edits: review.edits, guidance: review.fallback, view: null }
      const polished = applyPolishEdits(texts, chosen)
      const view = await bodyEditor.save(sessionId, { token: edit.token, texts: polished })
      notifyPluginTimeline(sessionId, 'edit', { settled: true })
      // The record backs the 精修对比 page and its undo; one that cannot be kept never fails the 精修.
      await polishRecords.save(sessionId, edit.turn, { original: texts, edits: chosen, seconds: Math.round((Date.now() - started) / 1000) })
        .catch(error => console.warn('dsh-tavern: 精修记录保存失败', error))
      return { edits: review.edits, view }
    },
    async polishComparison(args) {
      return { comparison: await polishRecords.latest(str(args?.sessionId)) }
    },
    // Undo the latest 精修, from the 精修对比 page: only while its turn still shows the polished text.
    async undoPolish(args) {
      const sessionId = str(args?.sessionId)
      await reconcileStory(sessionId)
      const record = await polishRecords.current(sessionId)
      if (!record) throw new Error('这轮正文在精修后又改过了，无法撤销')
      const edit = await bodyEditor.read(sessionId)
      if (Number(edit.turn) !== Number(record.turn)) throw new Error('精修的那一轮已经不是最后一轮，无法撤销')
      const view = await bodyEditor.save(sessionId, { token: edit.token, texts: record.original })
      notifyPluginTimeline(sessionId, 'edit', { settled: true })
      return { view }
    },
    async regenBody(args) {
      if (args?.restyle === true) await retryStyleReference(args.sessionId, { target: 'regenerate', guidance: args.styleGuidance })
      await reconcileStory(args && args.sessionId)
      const view = await regenBody(args && args.chatId, args && args.guidance, args && args.sessionId)
      notifyPluginTimeline(args && args.sessionId, 'regenerate')
      return { view }
    },
    async replayTurn(args) {
      const view = await replayFailedTurn(args && args.chatId, args && args.sessionId)
      notifyPluginTimeline(args && args.sessionId, 'regenerate')
      return { view }
    },
    async setAllFailedErrorVisibility(args) {
      const sessionId = str(args && args.sessionId)
      const chat = await chatForSession(sessionId)
      if (!chat) throw new Error('请先打开游玩会话')
      const session = sessionStore.get(sessionId) || agentRegistry.get(sessionId)?.session
      if (!session) throw new Error('会话尚未就绪，请刷新后重试')
      const events = sessionEvents(session)
      let changedCount = 0
      await updateChat(chat.id, current => {
        const result = setAllFailedErrorVisibility(current, events, args.hidden, args.turns)
        changedCount = result.changedCount
        return changedCount ? result.chat : undefined
      }, { source: 'ui.error-visibility.batch' })
      return { view: await sessionView(sessionId), changedCount }
    },
    async setFailedErrorVisibility(args) {
      const sessionId = str(args && args.sessionId)
      const chat = await chatForSession(sessionId)
      if (!chat) throw new Error('请先打开游玩会话')
      const session = sessionStore.get(sessionId) || agentRegistry.get(sessionId)?.session
      if (!session) throw new Error('会话尚未就绪，请刷新后重试')
      const events = sessionEvents(session)
      await updateChat(chat.id, current => setFailedErrorVisibility(current, events, args.turn, args.hidden), { source: 'ui.error-visibility' })
      return { view: await sessionView(sessionId) }
    },
    async undoRollbackTurn(args) {
      const view = await undoRollbackTurn(args && args.sessionId, args && args.chatId)
      notifyPluginTimeline(args && args.sessionId, 'undo-rollback', { settled: true })
      return { view }
    },
    // Diagnostics and tests: does the save agree with what the model sees? Read-only.
    async storyAlignment(args) {
      return { alignment: await reconcileStory(args && args.sessionId, { repair: false }) }
    },
    async rollbackTurn(args) {
      await reconcileStory(args && args.sessionId)
      const view = await rollbackTurn(args && args.sessionId, args && args.chatId, args && args.expectedTurn)
      notifyPluginTimeline(args && args.sessionId, 'rollback', { turn: args && args.expectedTurn })
      return { view }
    },
    async rollbackToTurn(args) {
      await reconcileStory(args && args.sessionId)
      const view = await rollbackToTurn(args && args.sessionId, args && args.chatId, args && args.turn)
      notifyPluginTimeline(args && args.sessionId, 'rollback', { turn: view?.rolledBackTo?.latest })
      return { view }
    },
    async getBackgroundProgress(args) {
      return { progress: backgroundAgentRunner.progress(args && args.sessionId) || pluginSettlementProgress.snapshot(args && args.sessionId) }
    },
    async stopBackground(args) {
      return { view: await stopBackground(args && args.sessionId, args && args.operationId) }
    },
    async retrySettlement(args) {
      return { view: await retrySettlement(args && args.sessionId, args && args.turn, args && args.guidance) }
    },
    async retryMvuSettlement(args) {
      return { view: await retrySettlement(args && args.sessionId, args && args.turn, args && args.guidance) }
    },
  }
}
