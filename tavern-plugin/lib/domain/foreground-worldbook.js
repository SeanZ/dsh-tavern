import { classifyWorldbookEntry, hasWorldbookPreprocessingSyntax } from './worldbook-entry-classification.js'
import { currentVirtualState, virtualEntryVersion, virtualDependencyHash, virtualHash, virtualScope, virtualDependencyHasDynamicValue } from './worldbook-virtual-state.js'
import { promptOrder } from './worldbook-activation.js'
import { worldbookRandomState, hasWorldbookRandom, entryRandom } from './worldbook-random.js'
import { estimateWorldBookTokens } from './worldbook-activation.js'
import { compactRecallDiagnostics, describeRecallEntries } from './worldbook-recall-log.js'
import { fingerprint, isMvuUpdateEntry } from './worldbook-recall.js'
import { prepareTemplateWorldbook, prepareWorldBookRecall, projectWorldBookTemplates } from './worldbook-recall.js'

/** Persist only preprocessing differences. Original bodies stay authoritative in
 * the bound worldbook, never copied wholesale into a Chat header cache. */
function preparationSnapshot(prepared, sourceEntries) {
  const sources = new Map(sourceEntries.map(entry => [entry.ref, entry]))
  const overrides = {}
  const refs = []
  for (const entry of prepared?.view?.entries || []) {
    const source = sources.get(entry.ref)
    if (!source) continue
    refs.push(entry.ref)
    const changes = {}
    for (const key of Object.keys(entry)) {
      if (JSON.stringify(entry[key]) !== JSON.stringify(source[key])) changes[key] = entry[key]
    }
    if (Object.keys(changes).length) overrides[entry.ref] = changes
  }
  return { templatePrepared: true, templateScopes: prepared.templateScopes,
    templateActivationRequests: prepared.templateActivationRequests, refs, overrides }
}
function restorePreparation(cached, worldBook) {
  const source = new Map((worldBook?.view?.entries || []).map(entry => [entry.ref, entry]))
  return { ...worldBook, templatePrepared: true, templateScopes: cached.templateScopes,
    templateActivationRequests: cached.templateActivationRequests,
    view: { ...worldBook?.view, entries: cached.refs.flatMap(ref => source.has(ref) ? [{ ...source.get(ref), ...cached.overrides?.[ref] }] : []) } }
}

/** A character designed in this game enters the next request once per design version,
 * even when nobody names it; afterwards it follows ordinary keyword recall. */
function unreadCharacterDesigns(worldBook, chat) {
  const names = new Set((chat.characterDesignDocument?.characters || []).map(character => character?.name).filter(Boolean))
  if (!names.size) return []
  return (worldBook?.view?.entries || []).filter(entry => {
    const design = entry.rawEntry?.extensions?.dsh_tavern_helper_extra?.characterDesign
    const read = chat.worldBookReads?.[entry.ref]
    return design && names.has(design.name) && entry.enabled !== false && String(entry.content || '').trim() && read?.fingerprint !== fingerprint(entry.content)
  }).map(entry => ({ ref: entry.ref, force: true, sourceRef: '[CHARACTER_DESIGN]' }))
}

/** One request uses one bound-book snapshot for both selection and rendering. */
export function createForegroundWorldbook({ bound, runtime, globalVariables, scanText = () => '' }) {
  const requests = new Map()
  const project = async function project({ requestKey, chat, card, userText, userTextInHistory = false, worldBook: snapshot, purpose = 'generation', signal, strategy = chat.worldbookStrategy || 'legacy', selectedRefs = [] }) {
    try {
      let worldBook = snapshot || await bound(chat.cardPath, card, chat, {purpose,userText})
      const turn = Number([...(chat.messages || [])].reverse().find(message => message?.role === 'assistant')?.turn) || 0
      const randomState = worldbookRandomState(chat, turn)
      // Older versions recorded the next-turn preview as a read. Let the first
      // real request re-evaluate that preview without suppressing its entries.
      const reads = { ...chat.worldBookReads }
      if (chat.preparedWorldBook && chat.preparedWorldBook.schemaVersion !== 2) {
        for (const ref of chat.preparedWorldBook.refs || []) {
          if (Number(reads[ref]?.turn) === Number(chat.preparedWorldBook.turn)) delete reads[ref]
        }
      }
      // Retired model screening must not suppress entries in older saves.
      for (const ref of Object.keys(reads)) if (reads[ref]?.kind === 'screened') delete reads[ref]
      const templateRuntime = await runtime(chat.sessionId), globals = await globalVariables()
      if (strategy === 'native-skills') {
        const sourceEntries = worldBook?.view?.entries || []
        const executionKey = String(requestKey ?? `${turn}:${purpose}:${virtualHash(userText || '')}`)
        const scope = virtualScope(chat)
        const version = virtualHash([executionKey, sourceEntries, selectedRefs])
        const previous = requests.get(scope)
        if (previous?.version === version) return await previous.result
        // Upstream preprocessing is an effectful whole-book batch without a
        // per-entry guard. Freeze it for one explicit execution request; ordinary
        // body edits may refresh, but new/changed decorators wait for next round.
        const persistedPreparation = chat.worldBookVirtualState?.scope === scope && chat.worldBookVirtualState.preprocessing?.requestKey === executionKey
          ? chat.worldBookVirtualState.preprocessing : null
        const reusingPreparation = previous?.requestKey === executionKey || Boolean(persistedPreparation)
        const preparation = previous?.requestKey === executionKey ? previous.preparation
          : persistedPreparation ? Promise.resolve({ sources: persistedPreparation.sources, snapshot: persistedPreparation.prepared, prepared: restorePreparation(persistedPreparation.prepared, worldBook) })
          : prepareTemplateWorldbook(worldBook, templateRuntime, chat, globals).then(prepared => ({ prepared, snapshot: preparationSnapshot(prepared, sourceEntries),
            sources: sourceEntries.map(entry => ({ ref: entry.ref, version: virtualEntryVersion(entry), decorated: hasWorldbookPreprocessingSyntax(entry), enabled: entry.enabled })) }))
        const result = (async () => {
          const initial = await preparation
          const preparationDiagnostics = []
          if (reusingPreparation) {
            const oldSources = new Map(initial.sources.map(entry => [entry.ref, entry]))
            const transformed = new Map((initial.prepared?.view?.entries || []).map(entry => [entry.ref, entry]))
            const current = new Map(sourceEntries.map(entry => [entry.ref, entry]))
            const revokedController = initial.sources.some(entry => entry.decorated && (!current.has(entry.ref) || (entry.enabled !== false && current.get(entry.ref).enabled === false)))
            const entries = sourceEntries.flatMap(entry => {
              const old = oldSources.get(entry.ref)
              if (old && old.version === virtualEntryVersion(entry)) return transformed.has(entry.ref) ? [transformed.get(entry.ref)] : []
              if (hasWorldbookPreprocessingSyntax(entry) || old?.decorated) {
                preparationDiagnostics.push({ kind: 'worldbook-template', code: 'preprocessing-edit-deferred-to-next-request', ref: entry.ref })
                return []
              }
              return [entry]
            })
            worldBook = { ...worldBook, templatePrepared: true, templateScopes: revokedController ? undefined : initial.prepared.templateScopes,
              templateActivationRequests: revokedController ? [] : initial.prepared.templateActivationRequests?.filter(request => entries.some(entry => entry.ref === request.ref)),
              view: { ...worldBook.view, entries } }
          } else worldBook = initial.prepared
          const preparedActivations = [...(worldBook?.templateActivationRequests || []), ...unreadCharacterDesigns(worldBook, chat), ...(worldBook?.pluginActivationRequests || []), ...selectedRefs.map(ref => ({ ref, force: false, sourceRef: '[STRATEGY]' }))]
          const previousState = previous?.requestKey === executionKey ? (await previous.result).virtualState : undefined
          const executionChat = previousState ? { ...chat, worldBookVirtualState: previousState } : chat
          const projected = await projectMandatoryWorldbook({ worldBook, sourceEntries, chat: executionChat, card, templateRuntime, globals, preparedActivations, randomState, turn, requestKey: executionKey, userText, userTextInHistory, scanText: scanText(chat) })
          if (initial.sources.some(entry => entry.decorated)) projected.virtualState.preprocessing = {
            requestKey: executionKey, sources: initial.sources,
            prepared: initial.snapshot
          }
          projected.diagnostics.push(...preparationDiagnostics)
          return projected
        })()
        requests.set(scope, { version, requestKey: executionKey, preparation, result })
        // A bounded foreground-request cache. No background scope is admitted.
        if (requests.size > 32) requests.delete(requests.keys().next().value)
        try { return await result } catch (error) { if (requests.get(scope)?.result === result) requests.delete(scope); throw error }
      }
      worldBook = await prepareTemplateWorldbook(worldBook, templateRuntime, chat, globals)
      const preparedActivations = [...(worldBook?.templateActivationRequests || []), ...unreadCharacterDesigns(worldBook, chat), ...(worldBook?.pluginActivationRequests || [])]
      let activationRequests = preparedActivations, recalled, projected
      const tokenCosts = {}
      const protectedRefs = () => new Set(activationRequests.flatMap(request => [request.ref, request.sourceRef]))
      // Rebuild from the same snapshot and original scopes; speculative passes never mutate Chat.
      // Only requests from controllers still selected survive to the next pass.
      const randomValues = []
      let converged = false
      for (let pass = 0; pass < 16; pass++) {
        let randomIndex = 0
        const random = () => { const index = randomIndex++; return randomValues[index] ?? (randomValues[index] = Math.random()) }
        recalled = prepareWorldBookRecall({ worldBook, chat: { ...chat, worldBookReads: reads }, card, turn, userText, userTextInHistory,
          scanText: scanText(chat), activationRequests, random, tokenCosts, ignoreBudget: pass === 0, protectedRefs: protectedRefs() })
        projected = await projectWorldBookTemplates({ worldBook, selectedEntries: recalled.entries || [], includeConstants: true,
          runtime: templateRuntime, globalVariables: globals, chat, card, activationRequests, random, randomSeed: randomState.seed })
        let costsChanged = false
        for (const entry of recalled.entries || []) {
          const output = projected.renderedEntries.find(output => output.ref === entry.ref)
          const cost = output ? estimateWorldBookTokens(output.text) + 2 : 0
          if (tokenCosts[entry.ref] !== cost) costsChanged = true
          tokenCosts[entry.ref] = cost
        }
        const next = [...preparedActivations, ...(projected.activationRequests || [])]
        const key = requests => JSON.stringify(requests.map(request => [request.sourceRef, request.ref, request.force]).sort())
        if (pass > 0 && !costsChanged && key(next) === key(activationRequests)) {
          converged = true; break
        }
        activationRequests = next
      }
      if (!converged) throw new Error('世界书脚本激活未在 16 次投影内收敛')
      // A failed/empty template was not injected and must not consume cooldown.
      const renderedRefs = new Set(projected.refs)
      const accepted = recalled.refs.filter(ref => renderedRefs.has(ref))
      const recorded = recalled.recordReads(chat.worldBookReads)
      const nextReads = { ...chat.worldBookReads }
      for (const ref of accepted) nextReads[ref] = recorded[ref]
      const evaluatedRefs = new Set((recalled.diagnostics || []).map(entry => entry.ref))
      const excluded = (worldBook?.view?.entries || []).filter(entry => !evaluatedRefs.has(entry.ref) && (entry.enabled === false || !String(entry.content || '').trim() || isMvuUpdateEntry(entry)))
        .map(entry => ({ ref: entry.ref, title: entry.title || entry.comment, reason: entry.enabled === false ? 'disabled' : !String(entry.content || '').trim() ? 'empty' : 'mvu-update' }))
      const outputs = projected.renderedEntries || []
      const entries = describeRecallEntries([...(recalled.diagnostics || []), ...excluded]).map(entry => {
        const outputIndex = outputs.findIndex(output => output.ref === entry.ref)
        const failure = projected.diagnostics.find(item => item.ref === entry.ref)
        return { ...entry, outputOrder: outputIndex >= 0 ? outputIndex + 1 : null,
          rendering: outputIndex >= 0 ? 'rendered' : failure ? failure.code : entry.reason === 'selected' ? 'empty-output' : 'not-selected' }
      })
      const log = { settings: { ...recalled.settings, cooldownTurns: 10 }, budget: recalled.budget,  scanSources: recalled.scanSources || [],
        counts: entries.reduce((result, entry) => { result[entry.reason] = (result[entry.reason] || 0) + 1; return result }, {}), entries, outputs,
        dynamicRefs: accepted, activationRequests, templateDiagnostics: projected.diagnostics }
      return { ...projected, randomState: { ...randomState, outputs: Object.fromEntries(outputs.filter(output => hasWorldbookRandom(worldBook.view.entries.find(entry => entry.ref === output.ref)?.content)).map(output => [output.ref, output.text])) }, log, context: projected.foregroundContext, refs: accepted, reads: nextReads,
        activation: { schemaVersion: 2, turn, refs: accepted, diagnostics: compactRecallDiagnostics(recalled.diagnostics), mode: recalled.kind }, error: null }
    } catch (error) {
      if (error.code === 'FULL_TEMPLATE_UNAVAILABLE') throw error
      return { log: { error: String(error?.message || error), entries: [], outputs: [], counts: {} }, context: '', refs: [], diagnostics: [], activation: { schemaVersion: 2, refs: [], mode: 'error' }, error: String(error?.message || error) }
    }
  }
  project.dispose = () => requests.clear()
  return project
}

/** Native strategy: static optional content is discoverable only as a skill;
 * dynamic optional entries retain native conditions. Each controller executes at
 * most once per request, including activation convergence and empty outputs. */
async function projectMandatoryWorldbook({ worldBook, sourceEntries, chat, card, templateRuntime, globals, preparedActivations, randomState, turn, requestKey, userText, userTextInHistory, scanText }) {
  const original = new Map(sourceEntries.map(entry => [entry.ref, entry]))
  const classify = entry => {
    const type = classifyWorldbookEntry(original.get(entry.ref) || entry)
    return virtualDependencyHasDynamicValue(type, chat, card, globals) ? { ...type, nativeFallback: true, occasion: 'request' } : type
  }
  const cacheReaders = new Map(sourceEntries.filter(entry => !classify(entry).nativeFallback).map(entry => [entry.ref, classify(entry).dependencies]))
  const virtualState = currentVirtualState(chat, sourceEntries)
  const executionSeed = chat.worldBookVirtualState?.scope === virtualState.scope && chat.worldBookVirtualState.execution?.requestKey === requestKey
    ? chat.worldBookVirtualState.execution.seed : randomState.seed
  virtualState.execution = { requestKey, seed: executionSeed }
  const visibleRefs = new Set((worldBook?.view?.entries || []).filter(entry => entry.enabled !== false).map(entry => entry.ref))
  virtualState.visibility = { version: virtualHash(sourceEntries), refs: [...visibleRefs] }
  for (const ref of Object.keys(virtualState.entries)) if (!visibleRefs.has(ref)) delete virtualState.entries[ref]
  const renderCache = new Map()
  // Persisted per-request projections prevent random/side-effect resampling after
  // an executor restart. Versions and the game scope were validated above.
  for (const [ref, snapshot] of Object.entries(virtualState.entries)) {
    if (snapshot.requestKey === requestKey && snapshot.projection) renderCache.set(ref, snapshot.projection)
  }
  const staticEntries = promptOrder((worldBook?.view?.entries || []).filter(entry => entry.enabled !== false && classify(entry).kind === 'static-constant' && !isMvuUpdateEntry(entry)))
  const staticPrefix = staticEntries.map(entry => String((original.get(entry.ref) || entry).content ?? '')).join('\n\n')
  let activationRequests = preparedActivations, projected, selectedEntries
  const key = requests => JSON.stringify(requests.map(({ sourceRef, ref, force }) => [sourceRef, ref, force]).sort())
  const selectionRandom = []
  const selectionStream = entryRandom(virtualHash([executionSeed, requestKey]), 'activation')
  for (let pass = 0; pass < 16; pass++) {
    let randomIndex = 0
    const random = () => { const index = randomIndex++; return selectionRandom[index] ?? (selectionRandom[index] = selectionStream()) }
    const dynamicBook = { ...worldBook, view: { ...worldBook?.view, entries: (worldBook?.view?.entries || []).filter(entry => classify(entry).dynamic) } }
    const recalled = prepareWorldBookRecall({ worldBook: dynamicBook, chat: { ...chat, worldBookReads: {} }, card, turn, userText, userTextInHistory, scanText, activationRequests, random })
    const forced = new Set(activationRequests.filter(request => request.force).map(request => request.ref))
    const activated = new Set((recalled.entries || []).map(entry => entry.ref))
    selectedEntries = (worldBook?.view?.entries || []).filter(entry =>
      (entry.enabled !== false || forced.has(entry.ref)) && !isMvuUpdateEntry(entry) &&
      activated.has(entry.ref))
    // Opaque native controllers can modify projection-local macro/template scopes.
    // Their presence is a defined render occasion for otherwise pure readers.
    const hasNativeController = selectedEntries.some(entry => classify(entry).nativeFallback)
    const toRender = selectedEntries.filter(entry => {
      const type = classify(entry), source = original.get(entry.ref) || entry
      if (type.kind === 'static-constant') return false // always prefix, never a history frame
      if (!type.dynamic) return false // static optional bodies are skill resources only, even for force requests
      const previous = virtualState.entries[entry.ref]
      const dependencyHash = virtualDependencyHash(type, chat, card, globals)
      return !previous || previous.version !== virtualEntryVersion(source) || hasNativeController ||
        (type.nativeFallback ? previous.requestKey !== requestKey : previous.dependencyHash !== dependencyHash)
    })
    projected = await projectWorldBookTemplates({ worldBook, selectedEntries: toRender, includeConstants: true,
      runtime: templateRuntime, globalVariables: globals, chat, card, activationRequests, randomSeed: virtualHash([executionSeed, requestKey]), renderCache, cacheReaders })
    const next = [...preparedActivations, ...(projected.activationRequests || [])]
    if (key(next) === key(activationRequests)) {
      const changed = []
      for (const entry of toRender) {
        const type = classify(entry)
        const output = projected.renderedEntries.find(output => output.ref === entry.ref)
        if (!type.dynamic) { if (output) changed.push(output); continue }
        if (projected.diagnostics.some(item => item.ref === entry.ref)) continue
        const text = output?.text || '', renderHash = virtualHash(text)
        const previous = chat.worldBookVirtualState?.scope === virtualState.scope ? chat.worldBookVirtualState.entries?.[entry.ref] : undefined
        const withdrawn = !text && Boolean(previous?.text || previous?.withdrawn)
        const contextText = text || (withdrawn ? `【世界书条目 ${entry.ref} 已更新为空；先前该条目的内容已撤回，不再作为当前设定。】` : '')
        virtualState.entries[entry.ref] = { contextText, withdrawn, version: virtualEntryVersion(original.get(entry.ref) || entry), text, renderHash, requestKey,
          dependencyHash: virtualDependencyHash(type, chat, card, globals), projection: renderCache.get(entry.ref) }
        if (contextText && previous?.renderHash !== renderHash) changed.push({ ...output, ref: entry.ref, text: contextText, renderHash })
      }
      const refs = changed.filter(output => !original.get(output.ref)?.constant).map(output => output.ref)
      const context = changed.map(output => output.text).join('\n\n')
      return { ...projected, context, foregroundContext: context, prefixContext: staticPrefix, staticPrefix, virtualState, changedVirtualRefs: changed.filter(output => classify(original.get(output.ref) || {}).dynamic).map(output => output.ref), renderedEntries: changed, refs, reads: { ...chat.worldBookReads },
        randomState: { ...randomState, seed: executionSeed, outputs: { ...randomState.outputs, ...Object.fromEntries(projected.renderedEntries
          .filter(output => hasWorldbookRandom(original.get(output.ref)?.content)).map(output => [output.ref, output.text])) } },
        activation: { schemaVersion: 2, turn, refs, diagnostics: [], mode: 'native-skills' },
        log: { strategy: 'native-skills', entries: selectedEntries.map(entry => ({ ref: entry.ref, title: entry.title, reason: classify(entry).kind })),
          outputs: changed, counts: { changed: changed.length, static: staticEntries.length }, activationRequests, templateDiagnostics: projected.diagnostics }, error: null }
    }
    activationRequests = next
  }
  throw new Error('世界书脚本激活未在 16 次投影内收敛')
}
