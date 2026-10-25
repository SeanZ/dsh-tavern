// 精修 runs: the review of the latest reply against the principles, the edit that follows the
// player's guidance, and the background pre-review that starts the review as soon as a reply is
// written, so pressing 精修 mostly finds it done.

import { createHash } from 'node:crypto'
import { buildPolishGuidanceRequest, buildPolishReviewRequest, parsePolishReview, polishReviewContext } from './polish-review.js'

function str(value) { return typeof value === 'string' ? value : value == null ? '' : String(value) }

/** The text version a review belongs to: the reply's text parts. */
export function polishTextKey(texts) {
  return createHash('sha256').update(JSON.stringify((texts || []).map(str))).digest('hex')
}

/** Model calls of a 精修, each reading the card and the latest floors of the game. */
export function createPolishReviewer({ latestFloors, readCard, prompt, callModel }) {
  async function material(sessionId) {
    const chat = await latestFloors(sessionId, 4)
    const card = await readCard(chat.cardPath).catch(() => undefined) || chat.cardDefinitionSnapshot?.raw?.data || chat.cardDefinitionSnapshot?.raw
    return { card, playerName: chat.macroState?.userName, ...polishReviewContext(chat.messages) }
  }
  return Object.freeze({
    /** The principles review of `texts`. */
    async review(sessionId, texts, signal) {
      const request = buildPolishReviewRequest({ principles: prompt('polish'), ...await material(sessionId), reply: texts.join('\n\n') })
      return parsePolishReview(await callModel({ sessionId, signal, ...request }), texts)
    },
    /** Edits that carry out the player's guidance on `texts`, nothing else. */
    async guide(sessionId, texts, guidance, signal) {
      const request = buildPolishGuidanceRequest({ instructions: prompt('polish-guidance'), ...await material(sessionId), reply: texts.join('\n\n'), guidance })
      return parsePolishReview(await callModel({ sessionId, signal, ...request }), texts)
    }
  })
}

/**
 * One review per game kept in memory, for the reply text it read. Starting again for the same
 * text keeps the running one; another text aborts it. A review is only handed to a 精修 of the
 * same text, so an edited, regenerated or rolled back reply never takes a stale one.
 */
export function createPolishPrereview({ enabled, readTexts, review, logger = console }) {
  const jobs = new Map()
  // Text versions a 精修 already produced or reviewed: reviewing them again would only cost.
  const settled = new Map()

  function cancel(sessionId) {
    const job = jobs.get(str(sessionId))
    if (!job) return
    jobs.delete(str(sessionId))
    job.controller.abort()
  }

  async function start(sessionId) {
    const id = str(sessionId)
    if (!id || !await enabled()) return false
    let texts
    try { texts = await readTexts(id) } catch { return false }
    if (!texts?.some(text => str(text).trim())) return false
    const key = polishTextKey(texts)
    if (jobs.get(id)?.key === key || settled.get(id)?.includes(key)) return false
    cancel(id)
    const controller = new AbortController()
    const job = { key, controller, result: review(id, texts, controller.signal) }
    // A failed pre-review only means 精修 reviews on the spot; the page never sees it.
    job.result.catch(error => {
      if (jobs.get(id) === job) jobs.delete(id)
      if (!controller.signal.aborted) logger.warn('dsh-tavern: 精修预审失败，点精修时会重新审稿:', str(error?.message || error))
    })
    jobs.set(id, job)
    return true
  }

  /** The pre-review of exactly these texts, waited for if still running; null when there is none. */
  async function take(sessionId, texts) {
    const id = str(sessionId), job = jobs.get(id)
    if (!job || job.key !== polishTextKey(texts)) return null
    try { return await job.result } catch { return null } finally { if (jobs.get(id) === job) jobs.delete(id) }
  }

  /** A 精修 has used these texts (or produced them); a pre-review of them would be wasted. */
  function settle(sessionId, ...versions) {
    const id = str(sessionId)
    settled.set(id, [...settled.get(id) || [], ...versions.filter(Boolean).map(polishTextKey)].slice(-4))
  }

  return Object.freeze({ start, take, cancel, settle, running: sessionId => jobs.has(str(sessionId)) })
}
