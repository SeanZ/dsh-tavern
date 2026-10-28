import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { characterNgrams, buildWorldbookSimilarityGraph, compileWorldbookSkillClusters, leidenCommunities } from '../tavern-plugin/lib/domain/worldbook-skill-clustering.js'
import { createWorldbookSkillCatalog } from '../tavern-plugin/lib/domain/worldbook-skill-catalog.js'

const entry = (ref, content, extra = {}) => ({ ref, content, ...extra })
const graph = (n, edges) => {
  const adj = Array.from({ length: n }, () => new Map())
  for (const [a, b, w = 1] of edges) { adj[a].set(b, w); adj[b].set(a, w) }
  return adj
}
const connected = (adj, set) => {
  const allowed = new Set(set); const seen = new Set(); const todo = [set[0]]
  while (todo.length) { const v = todo.pop(); if (seen.has(v)) continue; seen.add(v); for (const u of adj[v].keys()) if (allowed.has(u) && !seen.has(u)) todo.push(u) }
  return seen.size === set.length
}

test('Unicode character 2/3 grams, normalized TF-IDF, cosine and sparse symmetric graph', () => {
  const grams = characterNgrams('Ａb中😀')
  assert.ok(grams.has('ab')); assert.ok(grams.has('b中')); assert.ok(grams.has('ab中'))
  assert.ok(!grams.has('a')); assert.ok(!grams.has('ab中😀'))
  const { vectors, adjacency } = buildWorldbookSimilarityGraph([entry('a', '火山城守卫'), entry('b', '火山城守卫'), entry('c', '银河飞船')])
  for (const vector of vectors) assert.ok(Math.abs([...vector.values()].reduce((s, w) => s + w * w, 0) - 1) < 1e-10)
  assert.ok(Math.abs(adjacency[0].get(1) - 1) < 1e-10)
  assert.equal(adjacency[0].get(1), adjacency[1].get(0)); assert.equal(adjacency[0].has(2), false)
})

test('Leiden performs refinement and refined aggregation, not components or fixed k', () => {
  const adj = graph(7, [[0,1],[0,2],[1,2],[3,4],[3,5],[4,5],[2,3,0.01]])
  const result = leidenCommunities(adj, { resolution: 0.2 })
  assert.deepEqual(result.communities, [[0,1,2],[3,4,5],[6]])
  assert.ok(result.diagnostics.refinements > 0); assert.ok(result.diagnostics.aggregations > 0)
  assert.deepEqual(result, leidenCommunities(adj, { resolution: 0.2 }))
  assert.equal(leidenCommunities(adj, { resolution: 2 }).communities.length, 7)
})

test('Leiden refined subcommunities remain connected on mixed weighted graphs', () => {
  let splits = 0
  for (let seed = 1; seed <= 30; seed++) {
    const edges = []
    for (let a = 0; a < 14; a++) for (let b = a + 1; b < 14; b++) {
      const weight = ((a * 31 + b * 19 + seed * 37) % 101) / 100
      if (weight > 0.55) edges.push([a,b,weight])
    }
    const adj = graph(14, edges)
    const result = leidenCommunities(adj, { resolution: 0.25, seed })
    splits += result.diagnostics.refinedSplits
    for (const set of result.communities) assert.ok(connected(adj, set), `seed ${seed}: ${set}`)
    assert.equal(result.communities.flat().length, 14)
  }
  assert.ok(splits > 0, 'refinement must actually split locally moved partitions')
})

test('empty, tiny, duplicate body, mixed language, refs and source body preservation', () => {
  assert.deepEqual(compileWorldbookSkillClusters([]).clusters, [])
  const source = [entry('a', 'Exact\r\n  body 世界！'), entry('b', 'Exact\r\n  body 世界！')]
  const before = JSON.stringify(source)
  const result = compileWorldbookSkillClusters(source)
  assert.equal(result.clusters.length, 1)
  assert.deepEqual(result.clusters[0].refs, ['a','b'])
  assert.equal(JSON.stringify(source), before)
  assert.equal(compileWorldbookSkillClusters([entry('only','x')]).clusters.length, 1)
  assert.throws(() => compileWorldbookSkillClusters([entry('a','x'),entry('a','y')]), /unique/)
  // This layer receives classified static entries, and never evaluates even hostile text.
  const template = '<% globalThis.__worldbookCompileExecuted = true; %>'
  compileWorldbookSkillClusters([entry('literal', template)])
  assert.equal(globalThis.__worldbookCompileExecuted, undefined)
})

test('oversized communities recursively split by higher resolution Leiden', () => {
  const input = Array.from({length:24}, (_, i) => entry(`e${i}`, 'identical medieval castle guards'.repeat(10)))
  const result = compileWorldbookSkillClusters(input, { maxEntries: 5, maxCharacters: 2000 })
  assert.ok(result.clusters.every(c => c.refs.length <= 5))
  assert.deepEqual(result.clusters.flatMap(c => c.refs).sort(), input.map(e => e.ref).sort())
})

test('stable overlap matched IDs survive edit/add/delete with deterministic split ties', () => {
  const initial = [entry('a','火山城堡骑士'),entry('b','火山城堡骑士'),entry('c','银河宇航飞船'),entry('d','银河宇航飞船')]
  const first = compileWorldbookSkillClusters(initial)
  const next = compileWorldbookSkillClusters([...initial.slice(0,3),entry('e','银河宇航飞船')], { previousClusters: first.clusters })
  for (const cluster of first.clusters) assert.ok(next.clusters.some(c => c.id === cluster.id))
  const repeat = compileWorldbookSkillClusters([...initial].reverse(), { previousClusters: first.clusters })
  assert.deepEqual(repeat.clusters, first.clusters)
  const split = compileWorldbookSkillClusters(initial, { maxEntries: 1, previousClusters: first.clusters })
  assert.equal(new Set(split.clusters.map(c => c.id)).size, split.clusters.length)
  assert.deepEqual(split.clusters, compileWorldbookSkillClusters(initial, { maxEntries:1, previousClusters:first.clusters }).clusters)
})

test('worker catalog commits atomically, deduplicates versions, scopes games, and disposes', async () => {
  const catalog = createWorldbookSkillCatalog({ debounceMs:500 })
  try {
    const first = await catalog.update('game-one', [entry('a','城堡骑士')])
    assert.equal(catalog.read('game-one'), first)
    assert.equal(await catalog.update('game-one',[entry('a','城堡骑士')]), first)
    assert.equal(catalog.read('game-two'), null)
    const old = catalog.update('game-one',[entry('a','first edit')])
    const newer = catalog.update('game-one',[entry('b','latest edit')])
    assert.equal(catalog.read('game-one'), first)
    const [a,b] = await Promise.all([old,newer])
    assert.equal(a,b); assert.deepEqual(b.clusters.flatMap(c => c.refs), ['b'])
    const cancelled = catalog.update('game-one',[entry('c','pending')])
    catalog.dispose('game-one')
    await assert.rejects(cancelled,/disposed/)
    assert.equal(catalog.read('game-one'), null)
  } finally { catalog.dispose() }
  await assert.rejects(catalog.update('game-one',[]), /disposed/)
})

test('stale in-flight worker cannot publish after a newer generation or disposal', async () => {
  const workers = []
  const catalog = createWorldbookSkillCatalog({ debounceMs: 500, workerFactory: data => {
    const worker = new EventEmitter(); worker.data = data; worker.terminated = false
    worker.terminate = async () => { worker.terminated = true }; workers.push(worker); return worker
  } })
  const old = catalog.update('game',[entry('old','old')])
  const latest = catalog.update('game',[entry('new','new')])
  assert.equal(workers[0].terminated,true)
  workers[0].emit('message',{result:compileWorldbookSkillClusters(workers[0].data.entries)})
  assert.equal(catalog.read('game'),null)
  await new Promise(resolve => setTimeout(resolve, 530))
  const expected = compileWorldbookSkillClusters(workers[1].data.entries)
  workers[1].emit('message',{result:expected})
  assert.equal(await old,expected); assert.equal(await latest,expected)
  catalog.dispose()
  assert.equal(catalog.read('game'),null)
})


test('invalid algorithm bounds fail instead of looping or creating unbounded dense graphs', () => {
  assert.throws(() => leidenCommunities([], {iterations:Infinity}), /iterations/)
  assert.throws(() => leidenCommunities([], {resolution:NaN}), /finite/)
  assert.throws(() => leidenCommunities([], {theta:Infinity}), /finite/)
  assert.throws(() => buildWorldbookSimilarityGraph([], {neighbors:Infinity}), /neighbors/)
  assert.throws(() => buildWorldbookSimilarityGraph([], {minSimilarity:NaN}), /similarity/)
  assert.throws(() => compileWorldbookSkillClusters([], {maxEntries:Infinity}), /finite/)
  assert.throws(() => createWorldbookSkillCatalog({debounceMs:NaN}), /debounce/)
})

test('original repeated categories stay whole despite body size; unrelated uncategorized entries stay separate', () => {
  const input = Array.from({ length: 60 }, (_, i) => entry(`skill-${i}`, `原文${i}`.repeat(200), { title: `功法·招式${i}` }))
  input.push(entry('medicine-a', '草药甲', { title: '药·甲' }), entry('medicine-b', '草药乙', { title: '药·乙' }), entry('space', 'ZXQ星际飞船'), entry('sea', '海底珊瑚'))
  const result = compileWorldbookSkillClusters(input)
  assert.ok(result.clusters.some(c => c.refs.length === 60))
  assert.ok(result.clusters.some(c => c.refs.length === 2 && c.refs.includes('medicine-a')))
  assert.ok(!result.clusters.some(c => c.refs.includes('space') && c.refs.includes('sea')))
  assert.deepEqual(result.clusters.flatMap(c => c.refs).sort(), input.map(e => e.ref).sort())
  assert.deepEqual(compileWorldbookSkillClusters([...input].reverse()).clusters, result.clusters)
})

test('discovery is capped below 30 without losing entries, with deterministic coarsening', () => {
  const input = Array.from({ length: 80 }, (_, i) => entry(`entry-${i}`, `独立资料${i}`, { title: `分类${i}·资料` }))
  const a = compileWorldbookSkillClusters(input, { minSimilarity: 1 })
  assert.equal(a.clusters.length, 29)
  assert.equal(new Set(a.clusters.flatMap(c => c.refs)).size, input.length)
  assert.deepEqual(a.clusters.flatMap(c => c.refs).sort(), input.map(e => e.ref).sort())
  assert.deepEqual(a.clusters, compileWorldbookSkillClusters([...input].reverse(), { minSimilarity: 1 }).clusters)
  assert.equal(compileWorldbookSkillClusters(input, { maxSkills: 5, minSimilarity: 1 }).clusters.length, 5)
  assert.throws(() => compileWorldbookSkillClusters(input, { maxSkills: 30 }), /29/)
})

test('bracketed author paths form readable broad categories instead of tiny city clusters', () => {
  const input = ['[王国-城镇-港口]', '[王国-城镇-王都]', '[王国-地理-平原]', '[种族-人类]', '[种族-精灵]'].map((title, i) => entry(`path-${i}`, '资料' + i, { title }))
  const result = compileWorldbookSkillClusters(input)
  assert.equal(result.clusters.length, 2)
  assert.ok(result.clusters.some(c => c.refs.length === 3))
})

test('incremental membership keeps edited and unrelated groups stable while accepting additions/deletions', () => {
  const initial = [entry('a','港口船厂',{title:'王国·港口'}),entry('b','农田',{title:'王国·农田'}),entry('c','医术药剂',{title:'医术·药剂'}),entry('d','止血',{title:'医术·止血'})]
  const first = compileWorldbookSkillClusters(initial)
  const modified = [{...initial[0],content:'彻底改写正文'},initial[2],initial[3],entry('e','新城镇',{title:'王国·新城'})]
  const next = compileWorldbookSkillClusters(modified,{previousClusters:first.clusters,preserveMembership:true})
  for(const old of first.clusters)assert.equal(next.clusters.find(c=>c.refs.includes(old.refs[0])).id,old.id)
  assert.ok(next.clusters.some(c=>c.refs.includes('a')&&c.refs.includes('e')))
  assert.deepEqual(next.clusters.flatMap(c=>c.refs).sort(),['a','c','d','e'])
  assert.equal(next.metrics.incremental,true)
  const bodyOnly=compileWorldbookSkillClusters(modified.map(e=>({...e,content:'changed'})),{previousClusters:next.clusters,preserveMembership:true})
  assert.deepEqual(bodyOnly.clusters.map(c=>[c.id,c.refs]),next.clusters.map(c=>[c.id,c.refs]))
  assert.equal(bodyOnly.metrics.addedEntries,0)
})
