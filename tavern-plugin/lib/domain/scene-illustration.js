import { createHash } from 'node:crypto'
import { projectAgentContent } from './runtime-content-projection.js'
import { SCENE_EXTRA_SLOTS, sceneSlotKey } from './scene-slots.js'

// Pictures Tavern itself drew before image generation moved to plugins. Tavern
// draws nothing new: it only shows, exports, lists and deletes these old pictures.
const hash = value => createHash('sha256').update(value).digest('hex')
function versionsOf(record) {
  if (Array.isArray(record?.versions)) return record.versions
  return record?.attachment ? [{ id: record.requestId || 'legacy', requestId: record.requestId, attachment: record.attachment, prompt: record.prompt, model: record.model, createdAt: record.completedAt || record.createdAt, plan: record.plan }] : []
}

function slotTarget(target, slot) {
  return slot ? { ...target, key: sceneSlotKey(target.key, slot), slot, baseKey: target.key } : target
}
function slotOf(target, key) {
  if (!key || key === target.key) return 0
  for (let slot = 1; slot <= SCENE_EXTRA_SLOTS; slot++) if (sceneSlotKey(target.key, slot) === key) return slot
  return -1
}

export function sceneTarget(chat, turn) {
  turn = Number(turn)
  if (!Number.isSafeInteger(turn) || turn < 1) throw new Error('正文轮次不合法')
  if (!chat || !['story', 'script'].includes(chat.mode || 'story')) throw new Error('请先打开游玩对话')
  if(chat.sceneTargets){
    if(chat.sceneTargets[turn])return {...chat.sceneTargets[turn]}
    throw Object.assign(new Error('这段正文已不存在'),{code:'SCENE_TARGET_UNAVAILABLE'})
  }
  return computeSceneTarget(chat, turn)
}

/** The key from the chat itself, ignoring any precomputed sceneTargets (they embed the chat id). */
/** The digest a reply's scene key uses for its text (computeSceneTarget). */
export function sceneSourceDigest(text) {
  return hash(String(text ?? ''))
}

export function computeSceneTarget(chat, turn) {
  turn = Number(turn)
  const index = (chat.messages || []).findIndex(message => message?.role === 'assistant' && Number(message.turn || (message.greeting ? 1 : 0)) === Number(turn))
  if (index < 0) throw Object.assign(new Error('这段正文已不存在'), { code: 'SCENE_TARGET_UNAVAILABLE' })
  const message = chat.messages[index]
  const swipeId = Math.max(0, Number(message.swipeId) || 0)
  const source = String(message.swipes?.[swipeId] ?? message.sourceText ?? message.text ?? '')
  // 自动精修 rewords a reply without changing its scene: it keeps the original text's digest.
  const sourceDigest = message.polishedFrom || hash(source)
  // A prefix digest distinguishes rolled-back/replaced story branches, while
  // appending later rounds or changing variable metadata does not invalidate art.
  const prefix = chat.messages.slice(0, index).map(item => [item.role, item.turn, item.sourceText ?? item.text])
  const key = hash(JSON.stringify([chat.id, prefix, index, turn, swipeId, sourceDigest]))
  return { key, turn: Number(turn), swipeId, sourceDigest, source }
}

export function projectedSceneText(source, macroState) {
  return projectAgentContent(source, { macroState }).agentText
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '').trim()
}

/** Read-only access to old scene pictures; never writes story messages or game state. */
export function createSceneIllustrations(deps) {
  const pathFor = (chatId, key) => 'scene-images/' + hash(String(chatId)) + '/' + key + '.json'
  // Coalesce simultaneous display reads; never cache across completed reads or mutations.
  const statusReads = new Map()
  async function readStatusChat(sessionId, turn) {
    if (!statusReads.has(sessionId)) {
      const entry = { turn }
      entry.promise = Promise.resolve().then(() => (deps.sceneStateForSession || deps.chatForSession)(sessionId, { turns: [Number(turn)] })).finally(() => statusReads.delete(sessionId))
      statusReads.set(sessionId, entry)
    }
    const entry = statusReads.get(sessionId), chat = await entry.promise
    // Full legacy projections can still coalesce across turns. Native point
    // projections are bounded; request other targets at the same pinned head.
    return chat?.sceneTargets && Number(entry.turn) !== Number(turn)
      ? deps.sceneStateForSession(sessionId, { turns: [Number(turn)], revision: chat._storageRevision }) : chat
  }
  // `key` selects one of the turn's picture slots; an unknown key keeps the
  // turn's own target so callers report that the story version changed.
  async function resolve(sessionId, turn, readChat = id => deps.chatForSession(id), key) {
    const chat = await readChat(sessionId, turn)
    const base = sceneTarget(chat, turn)
    const slot = slotOf(base, key)
    const target = slot > 0 ? slotTarget(base, slot) : base
    return { chat, target, base, path: pathFor(chat.id, target.key) }
  }
  // Which style a picture was drawn in, in the words saved with its plan.
  function styleLabel(plan) {
    if (plan?.styleOverride) return '单图风格：' + plan.styleOverride.tags
    if (plan?.artStyle) return plan.artStyle.text ? plan.artStyle.text + '（' + plan.artStyle.tags + '）' : plan.artStyle.tags || ''
    return plan?.style?.tags || plan?.style?.selection?.game || ''
  }
  function present(target, record) {
    return { key: target.key, turn: target.turn, versions: versionsOf(record).filter(item => item.attachment).map(({ id, createdAt, plan, prompt }) => ({ id, createdAt, prompt: prompt || '',
      description: plan?.description || '', style: styleLabel(plan), anchor: plan?.anchor || '', moment: plan?.moment || 'end', composition: plan?.scene?.composition?.text || '' })) }
  }
  async function status(sessionId, turn) {
    let resolved
    try { resolved = await resolve(sessionId, turn, readStatusChat) } catch (error) {
      if (error.code !== 'SCENE_TARGET_UNAVAILABLE') throw error
      return { turn: Number(turn), status: 'unavailable', reason: 'target-unavailable', versions: [] }
    }
    const { chat, target, path } = resolved
    // Added pictures of this turn, each in its own slot.
    const extras = []
    for (let slot = 1; slot <= SCENE_EXTRA_SLOTS; slot++) {
      const extra = slotTarget(target, slot), record = await deps.store.readJson(pathFor(chat.id, extra.key))
      if (versionsOf(record).some(item => item.attachment)) extras.push({ ...present(extra, record), slot })
    }
    return { ...present(target, await deps.store.readJson(path)), extras }
  }
  async function readImage(sessionId, turn, key, versionId) {
    const { target, path } = await resolve(sessionId, turn, undefined, key)
    if (target.key !== key) throw new Error('图片不属于当前正文版本')
    const versions = versionsOf(await deps.store.readJson(path))
    const version = versionId ? versions.find(item => item.id === versionId) : versions.at(-1)
    if (!version?.attachment) throw new Error('图片不存在或已删除')
    return deps.attachments().readImage(version.attachment)
  }
  // The pictures a reader sees for each turn: each slot's latest version at its newest
  // anchor, the same pictures and places play shows by default. Turns without one are skipped.
  async function exportImages(sessionId, turns) {
    const images = []
    for (const turn of turns) {
      let resolved
      try { resolved = await resolve(sessionId, turn) } catch { continue }
      for (let slot = 0; slot <= SCENE_EXTRA_SLOTS; slot++) {
        try {
          const versions = versionsOf(await deps.store.readJson(pathFor(resolved.chat.id, sceneSlotKey(resolved.target.key, slot)))), version = versions.at(-1)
          if (!version?.attachment) continue
          const image = await deps.attachments().readImage(version.attachment)
          const anchor = versions.findLast(item => item.anchor)?.anchor || ''
          images.push({ turn: Number(turn), slot, mediaType: String(image.mediaType || version.attachment.mediaType || ""), data: image.data, anchor })
        } catch { /* A missing picture must not block exporting the story. */ }
      }
    }
    return images
  }
  async function detachVersion(path, versionId) {
    return deps.store.updateJson(path, record => {
      const versions = versionsOf(record)
      const removed = versions.find(item => item.id === versionId)
      if (!removed) throw new Error('图片版本不存在')
      const kept = versions.filter(item => item.id !== versionId)
      // Detach only this version. Host attachments may be shared; do not delete
      // their bytes blindly. Keep a tombstone for subsequent reference-aware GC.
      return { ...record, versions: kept, status: kept.length ? 'succeeded' : 'idle', error: '', deletedVersions: [...(record.deletedVersions || []), { ...removed, deletedAt: Date.now() }] }
    })
  }
  // History spans every game, including deleted ones whose session no longer resolves,
  // so these address a record by the chat id saved in it rather than by session and turn.
  const storedPath = (chatId, key) => {
    if (typeof chatId !== 'string' || !chatId || !/^[0-9a-f]{64}$/.test(String(key))) throw new Error('图片地址不合法')
    return pathFor(chatId, key)
  }
  // One game's pictures (the gallery), or every game's when no chat id is given.
  async function history(onlyChatId) {
    const games = new Map((await deps.chatSummaries?.() || []).map(chat => [chat.id, chat]))
    const items = []
    const only = onlyChatId ? hash(String(onlyChatId)) : ''
    for (const folder of await deps.store.list('scene-images')) {
      if (!folder.directory || only && folder.name !== only) continue
      for (const file of await deps.store.list('scene-images/' + folder.name)) {
        if (file.directory || !/^[0-9a-f]{64}\.json$/.test(file.name)) continue
        const record = await deps.store.readJson('scene-images/' + folder.name + '/' + file.name).catch(() => undefined)
        const chatId = record?.diagnosticContext?.chatId
        const versions = versionsOf(record).filter(item => item.attachment)
        if (typeof chatId !== 'string' || !versions.length || record.key + '.json' !== file.name || onlyChatId && chatId !== onlyChatId) continue
        const game = games.get(chatId)
        items.push({ chatId, sessionId: typeof record.diagnosticContext?.sessionId === 'string' ? record.diagnosticContext.sessionId : '', key: record.key, turn: Number(record.turn) || 0, cardName: game?.cardName || '', title: game?.title || '', deleted: !game,
          versions: versions.map(item => ({ id: item.id, description: item.plan?.description || item.description || '', createdAt: Number(item.createdAt) || 0 })) })
      }
    }
    const latest = item => Math.max(0, ...item.versions.map(version => version.createdAt))
    return items.sort((a, b) => latest(b) - latest(a))
  }
  async function readStoredImage(chatId, key, versionId) {
    const version = versionsOf(await deps.store.readJson(storedPath(chatId, key))).find(item => item.id === versionId)
    if (!version?.attachment) throw new Error('图片不存在或已删除')
    return deps.attachments().readImage(version.attachment)
  }
  async function removeStoredImages(items) {
    if (!Array.isArray(items) || items.length > 500) throw new Error('一次最多删除 500 张')
    const results = []
    // One at a time and independently: report exactly which pictures were removed.
    for (const item of items) {
      try { await detachVersion(storedPath(item?.chatId, item?.key), item?.versionId); results.push({ versionId: item.versionId, ok: true }) }
      catch (error) { results.push({ versionId: item?.versionId, ok: false, error: String(error?.message || error) }) }
    }
    return results
  }
  return { status, readImage, exportImages, history, readStoredImage, removeStoredImages }
}
