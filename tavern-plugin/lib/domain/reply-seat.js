import { surfaceReplacementRange } from './session-events.js'

const prose = (event) =>
  (event?.data?.message?.content || []).some((block) => block?.type === 'text' && String(block.text || '') !== '')

// 来源顺序规则：生产者按 Surface 顺序写 sourceEventSeqs，替换范围 start..end 必在其中。
// 范围内的来源是被这次替换盖住的正文，从范围末端往回优先；范围外的来源只由撤销恢复
// （restoreSurface 写 [占位, 原件]）引用原件，排在范围内之后，再按列表倒序。
// 这样范围外较新的来源不会夺走范围内的正文座位。
function sourceCandidates(sources, start, end) {
  const from = sources.indexOf(start)
  const to = sources.indexOf(end)
  const inside = from <= to ? sources.slice(from, to + 1).reverse() : [end, start]
  return [...inside, ...[...sources].reverse().filter((seq) => !inside.includes(seq))]
}

/** 沿有效替换来源找到宿主实际绘制的正文。无效端点和缺失来源不能用区间内其它正文兜底。 */
export function createReplySeatResolver(eventAt) {
  const known = new Map()
  function resolve(event) {
    if (!event || event.type !== 'assistant/message') return null
    if (known.has(event.seq)) return known.get(event.seq)
    known.set(event.seq, null)
    if (event.surfaceOp === 'append') {
      const turn = Number(event.data?.turn)
      const seat = prose(event) && Number.isSafeInteger(turn) && turn > 0 ? { seq: event.seq, turn } : null
      known.set(event.seq, seat)
      return seat
    }
    if (event.surfaceOp?.op !== 'replace') return null
    const { start, end } = surfaceReplacementRange(event.surfaceOp)
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start >= event.seq ||
      end >= event.seq ||
      !eventAt(start) ||
      !eventAt(end)
    )
      return null
    const sources = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : null
    if (
      sources &&
      (!sources.length ||
        !sources.includes(start) ||
        !sources.includes(end) ||
        sources.some((seq) => !Number.isSafeInteger(seq) || seq >= event.seq || !eventAt(seq)))
    )
      return null
    if (!sources && start > end) return null
    // 旧日志没有显式来源时才兼容范围；新日志只遍历声明的有效来源。
    const candidates = sources
      ? sourceCandidates(sources, start, end)
      : Array.from({ length: end - start + 1 }, (_, index) => end - index)
    for (const seq of candidates) {
      const source = eventAt(seq)
      if (source?.type !== 'assistant/message') continue
      const seat = resolve(source)
      if (seat) {
        known.set(event.seq, seat)
        return seat
      }
      // 正文替换链断裂时不退回其它故事；空的追加节点可以跳过。
      if (source.surfaceOp?.op === 'replace') return null
    }
    return null
  }
  return resolve
}
