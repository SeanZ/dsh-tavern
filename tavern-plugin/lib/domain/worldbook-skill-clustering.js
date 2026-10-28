import { createHash } from 'node:crypto'
import { worldbookEntryTitle, worldbookTitleParts } from './worldbook-skill-labels.js'

const hash = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 20)
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const EPS = 1e-12
const groups = labels => {
  const result = new Map()
  labels.forEach((label, i) => { if (!result.has(label)) result.set(label, []); result.get(label).push(i) })
  return [...result.values()]
}
function rng(seed) {
  let state = seed >>> 0
  return () => { state += 0x6D2B79F5; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296 }
}
function shuffled(values, random) {
  const result = [...values]
  for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]] }
  return result
}
function localMove(graph, labels, resolution, random) {
  const sizes = new Map()
  labels.forEach((label, i) => sizes.set(label, (sizes.get(label) || 0) + graph.mass[i]))
  let next = Math.max(-1, ...labels) + 1
  const queue = shuffled(labels.map((_, i) => i), random)
  const queued = new Set(queue)
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const v = queue[cursor]; queued.delete(v)
    const old = labels[v]; const mass = graph.mass[v]
    const edges = new Map()
    for (const [u, weight] of graph.adj[v]) edges.set(labels[u], (edges.get(labels[u]) || 0) + weight)
    const oldScore = (edges.get(old) || 0) - resolution * mass * (sizes.get(old) - mass)
    let target = old; let best = oldScore
    if (0 > best + EPS) { target = next; best = 0 }
    for (const [label, weight] of edges) {
      if (label === old) continue
      const score = weight - resolution * mass * sizes.get(label)
      if (score > best + EPS || (score > oldScore + EPS && Math.abs(score - best) <= EPS && label < target)) { best = score; target = label }
    }
    if (target === old) continue
    if (target === next) next++
    sizes.set(old, sizes.get(old) - mass); sizes.set(target, (sizes.get(target) || 0) + mass); labels[v] = target
    for (const u of graph.adj[v].keys()) if (labels[u] !== target && !queued.has(u)) { queued.add(u); queue.push(u) }
  }
  return labels
}

// Original implementation of Traag/Waltman/van Eck (2019), Appendix A.2:
// https://www.traag.net/wp/wp-content/papercite-data/pdf/traag_leiden_algo_2018.pdf
// CPM objective; fast local moving, constrained RANDOM refinement, then aggregation
// by the refined partition with the UNREFINED partition as its initial labels.
// This is not Louvain, nor a connected-components postprocessing approximation.
function refine(graph, labels, resolution, random, theta) {
  const refined = labels.map((_, i) => i)
  const members = new Map(refined.map(i => [i, new Set([i])]))
  const mass = new Map(refined.map(i => [i, graph.mass[i]]))
  for (const subset of groups(labels)) {
    const inSubset = new Set(subset)
    const total = subset.reduce((sum, v) => sum + graph.mass[v], 0)
    const boundary = community => {
      let weight = 0
      for (const v of members.get(community)) for (const [u, w] of graph.adj[v]) if (inSubset.has(u) && refined[u] !== community) weight += w
      return weight
    }
    const eligible = subset.filter(v => {
      let weight = 0
      for (const [u, w] of graph.adj[v]) if (inSubset.has(u)) weight += w
      return weight + EPS >= resolution * graph.mass[v] * (total - graph.mass[v])
    })
    for (const v of shuffled(eligible, random)) {
      const own = refined[v]
      if (members.get(own).size !== 1) continue
      const edges = new Map()
      for (const [u, w] of graph.adj[v]) if (inSubset.has(u)) edges.set(refined[u], (edges.get(refined[u]) || 0) + w)
      const choices = [{ label: own, gain: 0 }]
      for (const [label, weight] of edges) {
        if (label === own) continue
        const size = mass.get(label)
        if (boundary(label) + EPS < resolution * size * (total - size)) continue
        const gain = weight - resolution * graph.mass[v] * size
        if (gain >= -EPS) choices.push({ label, gain: Math.max(0, gain) })
      }
      choices.sort((a, b) => a.label - b.label)
      const max = Math.max(...choices.map(c => c.gain))
      const weights = choices.map(c => Math.exp((c.gain - max) / theta))
      let draw = random() * weights.reduce((a, b) => a + b, 0)
      let target = choices.at(-1).label
      for (let i = 0; i < choices.length; i++) { draw -= weights[i]; if (draw <= 0) { target = choices[i].label; break } }
      if (target === own) continue
      members.get(own).delete(v); members.get(target).add(v)
      mass.set(target, mass.get(target) + graph.mass[v]); mass.set(own, 0); refined[v] = target
    }
  }
  return refined
}
function aggregate(graph, refined, labels) {
  const sets = groups(refined)
  const owner = []
  sets.forEach((set, i) => set.forEach(v => { owner[v] = i }))
  const adj = sets.map(() => new Map())
  graph.adj.forEach((edges, v) => { for (const [u, weight] of edges) if (owner[v] !== owner[u]) adj[owner[v]].set(owner[u], (adj[owner[v]].get(owner[u]) || 0) + weight) })
  return { graph: { adj, mass: sets.map(set => set.reduce((sum, v) => sum + graph.mass[v], 0)), originals: sets.map(set => set.flatMap(v => graph.originals[v])) }, labels: sets.map(set => labels[set[0]]) }
}

// A bounded number of seeded iterations is deliberate; no claim of asymptotic
// convergence or global/subset optimality is made.
export function leidenCommunities(adjacency, { resolution = 0.08, seed = 42, iterations = 4, theta = 0.01 } = {}) {
  if (!Number.isFinite(resolution) || !(resolution > 0) || !Number.isFinite(theta) || !(theta > 0)) throw new Error('Leiden resolution and theta must be finite and positive')
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100) throw new Error('Leiden iterations must be an integer between 1 and 100')
  const base = { adj: adjacency, mass: adjacency.map(() => 1), originals: adjacency.map((_, i) => [i]) }
  const random = rng(seed)
  let partition = adjacency.map((_, i) => [i])
  const diagnostics = { refinements: 0, refinedSplits: 0, aggregations: 0 }
  for (let iteration = 0; iteration < iterations; iteration++) {
    let graph = base; let labels = []
    partition.forEach((set, c) => set.forEach(v => { labels[v] = c }))
    let idle = 0
    while (graph.adj.length) {
      labels = localMove(graph, labels, resolution, random)
      if (groups(labels).length === graph.adj.length) break
      const refined = refine(graph, labels, resolution, random, theta)
      diagnostics.refinements++
      diagnostics.refinedSplits += groups(refined).length - groups(labels).length
      if (groups(refined).length === graph.adj.length) {
        // A stochastic refinement may choose all stay moves. Retry rather than
        // silently substituting the unrefined (Louvain) partition.
        if (++idle > 128) throw new Error('Leiden refinement failed to progress')
        continue
      }
      idle = 0
      const next = aggregate(graph, refined, labels)
      graph = next.graph; labels = next.labels; diagnostics.aggregations++
    }
    partition = groups(labels).map(set => set.flatMap(v => graph.originals[v]).sort((a, b) => a - b)).sort((a, b) => a[0] - b[0])
  }
  return { communities: partition, diagnostics }
}

export function characterNgrams(value) {
  const result = new Map()
  const chars = Array.from(String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim())
  for (const width of [2, 3]) for (let i = 0; i + width <= chars.length; i++) {
    const term = chars.slice(i, i + width).join('')
    if (!/[\p{L}\p{N}]/u.test(term)) continue
    result.set(term, (result.get(term) || 0) + 1)
  }
  return result
}
export function buildWorldbookSimilarityGraph(entries, { neighbors = 12, minSimilarity = 0.08 } = {}) {
  if (!Number.isInteger(neighbors) || neighbors < 1 || neighbors > 1024) throw new Error('Graph neighbors must be an integer between 1 and 1024')
  if (!Number.isFinite(minSimilarity) || minSimilarity < 0 || minSimilarity > 1) throw new Error('Graph minimum similarity must be between 0 and 1')
  const counts = entries.map(entry => characterNgrams([entry.title, entry.comment, ...(entry.primaryKeys || []), ...(entry.secondaryKeys || []), entry.content].filter(Boolean).join('\n')))
  const df = new Map()
  for (const document of counts) for (const term of document.keys()) df.set(term, (df.get(term) || 0) + 1)
  const vectors = counts.map(document => {
    const vector = new Map([...document].map(([term, count]) => [term, (1 + Math.log(count)) * (1 + Math.log((1 + entries.length) / (1 + df.get(term))))]))
    const norm = Math.sqrt([...vector.values()].reduce((sum, weight) => sum + weight * weight, 0)) || 1
    for (const [term, weight] of vector) vector.set(term, weight / norm)
    return vector
  })
  const postings = new Map()
  vectors.forEach((vector, i) => { for (const [term, weight] of vector) { if (!postings.has(term)) postings.set(term, []); postings.get(term).push([i, weight]) } })
  const adj = entries.map(() => new Map())
  vectors.forEach((vector, i) => {
    const similarities = new Map()
    for (const [term, weight] of vector) for (const [j, otherWeight] of postings.get(term)) if (i !== j) similarities.set(j, (similarities.get(j) || 0) + weight * otherWeight)
    // Equal-similarity documents (common in duplicated worldbooks) must not all
    // select the same lowest-index hubs. A stable circular tie order distributes
    // kNN ties without introducing a fixed community count.
    const distance = j => Math.min(Math.abs(i - j), entries.length - Math.abs(i - j))
    const nearest = [...similarities].filter(([, weight]) => weight >= minSimilarity).sort((a, b) => Math.abs(b[1] - a[1]) > EPS ? b[1] - a[1] : distance(a[0]) - distance(b[0]) || a[0] - b[0]).slice(0, neighbors)
    for (const [j, weight] of nearest) { adj[i].set(j, weight); adj[j].set(i, weight) }
  })
  return { adjacency: adj, vectors, vocabularySize: df.size }
}

export function worldbookEntryHash(entry) { return hash(JSON.stringify(entry)) }
export function worldbookClusterInputHash(entries) { return hash(JSON.stringify(entries.map(entry => [entry.ref, worldbookEntryHash(entry)]).sort((a, b) => compare(a[0], b[0])))) }

// Bound discovery cost without dropping source entries. Absorb the smallest
// community into its nearest TF-IDF centroid; ties prefer smaller groups and
// stable source order. This is a local deterministic coarsening pass, not an LLM.
function capCommunities(sets, vectors, limit) {
  const centroid = indices => {
    const sums = new Map()
    for (const i of indices) for (const [term, weight] of vectors[i]) sums.set(term, (sums.get(term) || 0) + weight)
    const norm = Math.sqrt([...sums.values()].reduce((sum, value) => sum + value * value, 0)) || 1
    return new Map([...sums].map(([term, weight]) => [term, weight / norm]))
  }
  const groups = sets.map(indices => ({ indices, vector: centroid(indices) }))
  while (groups.length > limit) {
    groups.sort((a, b) => a.indices.length - b.indices.length || a.indices[0] - b.indices[0])
    const source = groups.shift()
    let best = 0, score = -1
    groups.forEach((target, index) => {
      let similarity = 0
      const [small, large] = source.vector.size < target.vector.size ? [source.vector, target.vector] : [target.vector, source.vector]
      for (const [term, weight] of small) similarity += weight * (large.get(term) || 0)
      if (similarity > score + EPS) { score = similarity; best = index }
    })
    const indices = [...groups[best].indices, ...source.indices].sort((a, b) => a - b)
    groups[best] = { indices, vector: centroid(indices) }
  }
  return groups.map(group => group.indices)
}

function updateMembership(entries, previousClusters, maxSkills) {
  const byRef = new Map(entries.map(entry => [entry.ref, entry]))
  const assigned = new Set()
  const clusters = previousClusters.map(cluster => ({ ...cluster, refs: cluster.refs.filter(ref => {
    if (!byRef.has(ref) || assigned.has(ref)) return false
    assigned.add(ref); return true
  }) })).filter(cluster => cluster.refs.length)
  if (clusters.length > maxSkills) return null
  const additions = entries.filter(entry => !assigned.has(entry.ref))
  const newClusters = additions.length ? compileWorldbookSkillClusters(additions, { maxSkills }).clusters : []
  const parent = entry => { const parts = worldbookTitleParts(worldbookEntryTitle(entry)); return parts.length > 1 ? parts[0] : '' }
  // Body-only edits and deletions never rebuild the similarity graph.
  const vectors = additions.length ? buildWorldbookSimilarityGraph(entries).vectors : []
  const indices = new Map(entries.map((entry, index) => [entry.ref, index]))
  const sum = refs => {
    const vector = new Map()
    for (const ref of refs) for (const [term, weight] of vectors[indices.get(ref)]) vector.set(term, (vector.get(term) || 0) + weight)
    const norm = Math.sqrt([...vector.values()].reduce((n, value) => n + value * value, 0)) || 1
    return new Map([...vector].map(([term, weight]) => [term, weight / norm]))
  }
  for (const added of newClusters) {
    const parents = new Set(added.refs.map(ref => parent(byRef.get(ref))).filter(Boolean))
    let target = parents.size === 1 ? clusters.find(cluster => cluster.refs.some(ref => parents.has(parent(byRef.get(ref))))) : undefined
    if (!target && clusters.length < maxSkills) {
      const base = added.id
      let suffix = 2
      while (clusters.some(cluster => cluster.id === added.id)) added.id = `${base}-${suffix++}`
      clusters.push(added); continue
    }
    if (!target) {
      const vector = sum(added.refs)
      let score = -1
      for (const cluster of clusters) {
        const other = sum(cluster.refs)
        let similarity = 0
        for (const [term, weight] of vector) similarity += weight * (other.get(term) || 0)
        if (similarity > score + EPS) { score = similarity; target = cluster }
      }
    }
    target.refs = [...target.refs, ...added.refs].sort(compare)
  }
  return { clusters, entryHashes: Object.fromEntries(entries.map(entry => [entry.ref, worldbookEntryHash(entry)])), inputHash: worldbookClusterInputHash(entries),
    metrics: { entries: entries.length, clusters: clusters.length, maxSkills, incremental: true, addedEntries: additions.length } }
}

export function compileWorldbookSkillClusters(input, { previousClusters = [], preserveMembership = false, maxSkills = 29, maxEntries = Number.MAX_SAFE_INTEGER, maxCharacters = Number.MAX_SAFE_INTEGER, resolution = 0.02, respectSourceCategories = true, ...graphOptions } = {}) {
  if (!Number.isInteger(maxSkills) || maxSkills < 1 || maxSkills > 29) throw new Error('Skill count limit must be an integer between 1 and 29')
  const started = performance.now()
  const entries = [...input].sort((a, b) => compare(String(a.ref), String(b.ref)))
  if (new Set(entries.map(e => e.ref)).size !== entries.length) throw new Error('Worldbook entry refs must be unique')
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isInteger(maxCharacters) || maxCharacters < 1) throw new Error('Cluster size limits must be finite positive integers')
  if (preserveMembership && previousClusters.length && maxEntries === Number.MAX_SAFE_INTEGER && maxCharacters === Number.MAX_SAFE_INTEGER) {
    const updated = updateMembership(entries, previousClusters, maxSkills)
    if (updated) return { ...updated, metrics: { ...updated.metrics, elapsedMs: performance.now() - started } }
  }
  const { adjacency, vectors, vocabularySize } = buildWorldbookSimilarityGraph(entries, graphOptions)
  let refinements = 0; let refinedSplits = 0; let aggregations = 0
  // maxCharacters counts original-content UTF-16 code units, excluding metadata.
  const partition = (indices, gamma) => {
    const local = new Map(indices.map((index, i) => [index, i]))
    const graph = indices.map(index => new Map([...adjacency[index]].filter(([j]) => local.has(j)).map(([j, weight]) => [local.get(j), weight])))
    const result = leidenCommunities(graph, { resolution: gamma })
    refinements += result.diagnostics.refinements; refinedSplits += result.diagnostics.refinedSplits; aggregations += result.diagnostics.aggregations
    return result.communities.flatMap(set => {
      const indicesInGroup = set.map(i => indices[i])
      const size = indicesInGroup.reduce((sum, i) => sum + String(entries[i].content || '').length, 0)
      // A single oversized source entry remains intact: splitting or truncating
      // the authoritative body is forbidden; only multi-entry groups can split.
      if (set.length <= 1 || (set.length <= maxEntries && size <= maxCharacters)) return [indicesInGroup]
      // Re-run real Leiden on the induced oversized community at higher CPM
      // resolution. Above maximum edge weight, singleton output is guaranteed.
      return partition(indicesInGroup, gamma * 2)
    })
  }
  // Original title hierarchy is stronger evidence than body-level n-gram
  // similarity. Keep a repeated parent category as one discovery entry.
  // File size belongs to progressive reading, not Skill discovery granularity.
  const categories = new Map()
  if (respectSourceCategories) entries.forEach((entry, i) => {
    const parts = worldbookTitleParts(worldbookEntryTitle(entry))
    if (parts.length < 2) return
    if (!categories.has(parts[0])) categories.set(parts[0], [])
    categories.get(parts[0]).push(i)
  })
  const structured = [...categories.values()].filter(indices => indices.length > 1)
  const assigned = new Set(structured.flat())
  const fallback = entries.map((_, i) => i).filter(i => !assigned.has(i))
  const initialSets = [...structured, ...partition(fallback, resolution)]
  const sets = initialSets.length > maxSkills ? capCommunities(initialSets, vectors, maxSkills) : initialSets
  const clusters = sets.map(set => {
    const scores = new Map()
    for (const i of set) for (const [term, weight] of vectors[i]) if (/^[\p{L}\p{N}]+$/u.test(term)) scores.set(term, (scores.get(term) || 0) + weight)
    const keywords = []
    for (const [term] of [...scores].sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))) {
      if (!keywords.some(prior => prior.includes(term))) keywords.push(term)
      if (keywords.length === 6) break
    }
    const refs = set.map(i => entries[i].ref)
    const title = keywords.slice(0, 3).join(' · ') || String(entries[set[0]]?.title || '世界书资料').slice(0, 60)
    return { id: '', refs, keywords, title, description: `世界书主题：${title}。包含 ${refs.length} 条原始资料；按需读取 references/ 下原文。` }
  }).sort((a, b) => compare(String(a.refs[0]), String(b.refs[0])))
  const matches = []
  clusters.forEach((cluster, i) => previousClusters.forEach(previous => {
    const old = new Set(previous.refs); const overlap = cluster.refs.filter(ref => old.has(ref)).length
    if (overlap) matches.push({ i, id: previous.id, overlap, score: overlap / (old.size + cluster.refs.length - overlap) })
  }))
  matches.sort((a, b) => b.score - a.score || b.overlap - a.overlap || compare(a.id, b.id) || a.i - b.i)
  const used = new Set()
  for (const match of matches) if (!clusters[match.i].id && !used.has(match.id)) { clusters[match.i].id = match.id; used.add(match.id) }
  for (const cluster of clusters) if (!cluster.id) {
    let id = `topic-${hash(JSON.stringify(cluster.refs))}`; let suffix = 0
    while (used.has(id)) id = `topic-${hash(JSON.stringify(cluster.refs))}-${++suffix}`
    cluster.id = id; used.add(id)
  }
  return { clusters, entryHashes: Object.fromEntries(entries.map(entry => [entry.ref, worldbookEntryHash(entry)])), inputHash: worldbookClusterInputHash(entries), metrics: { entries: entries.length, vocabularySize, edges: adjacency.reduce((sum, neighbors) => sum + neighbors.size, 0) / 2, clusters: clusters.length, initialClusters: initialSets.length, maxSkills, sourceCategories: structured.length, fallbackEntries: fallback.length, refinements, refinedSplits, aggregations, elapsedMs: performance.now() - started } }
}
