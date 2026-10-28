import { sessionEvents } from './session-events.js'
import fs from 'node:fs/promises'
import { estimateWorldBookTokens } from './worldbook-activation.js'
import { describeWorldbookCluster, worldbookEntryTitle, worldbookSkillSlug } from './worldbook-skill-labels.js'
import path from 'node:path'
import { createWorldbookSkillFiles, skillDigest, skillFileLabel, referenceFile, legacyReferenceFile } from './worldbook-skill-files.js'
import { isStaticWorldbookSkillEntry } from './worldbook-entry-classification.js'
import { createWorldbookSkillCatalog } from './worldbook-skill-catalog.js'
import { eligibleVirtualSourceEntries } from './worldbook-virtual-state.js'

const digest = skillDigest
const text = value => String(value ?? '').replace(/\s+/g, ' ').trim()
const eligible = isStaticWorldbookSkillEntry
export const WORLDBOOK_SKILL_RESOURCE_ROOT = '/__tavern_worldbook__/'
const legacyScopeKey = state => digest(JSON.stringify([state.chat.sessionId, state.chat.id, state.chat.cardPath]))
// Shared by source and effective content, never by chat/session identity.
const sourceKeys = new WeakMap()
const scopeKey = state => {
  if (!sourceKeys.has(state)) sourceKeys.set(state, digest(JSON.stringify([state.chat.cardPath || null, [...new Set((state.worldBook?.view?.entries || []).map(e => e.sourcePath).filter(Boolean))].sort(), entriesOf(state)])))
  return sourceKeys.get(state)
}
const members = (state, cluster) => entriesOf(state).filter(entry => cluster.refs.includes(entry.ref))
const clusterDirectory = cluster => cluster.directoryName
export function nameWorldbookSkillDirectories(clusters, previousClusters = []) {
  const used = new Set(), names = new Map(), slugs = new Map(), usedSlugs = new Set()
  const previous = new Map(previousClusters.map(cluster => [cluster.id, cluster]))
  for (const cluster of clusters) {
    const old = previous.get(cluster.id)
    if (!old?.directoryName || !old?.skillName) continue
    names.set(cluster.id, old.directoryName); used.add(old.directoryName.toLocaleLowerCase('en-US'))
    slugs.set(cluster.id, old.skillName); usedSlugs.add(old.skillName)
  }
  // Stable ordering makes collision suffixes independent of catalog display order.
  for (const cluster of [...clusters].sort((a, b) => a.id.localeCompare(b.id))) {
    if (names.has(cluster.id)) continue
    const base = skillFileLabel(cluster.title.replace(/[\s·]+/g, '、'))
    let name = base, suffix = 2
    while (used.has(name.toLocaleLowerCase('en-US'))) name = `${base}--${suffix++}`
    used.add(name.toLocaleLowerCase('en-US')); names.set(cluster.id, name)
    const slugBase = worldbookSkillSlug(cluster.title)
    let slug = slugBase, number = 2
    while (usedSlugs.has(slug)) slug = `${slugBase}-${number++}`
    usedSlugs.add(slug); slugs.set(cluster.id, slug)
  }
  return clusters.map(cluster => ({ ...cluster, directoryName: names.get(cluster.id), skillName: slugs.get(cluster.id) }))
}
const sourceEntries = new WeakMap()
const entriesOf = state => {
  if (!sourceEntries.has(state)) sourceEntries.set(state, eligibleVirtualSourceEntries(state.worldBook, state.chat).filter(eligible))
  return sourceEntries.get(state)
}
const versionOf = state => JSON.stringify(entriesOf(state))
function abortable(promise, signal) {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('Worldbook lookup aborted'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** Per-game discovery of source-owned, shared Skill bundles. JSON is authoritative;
 * the host's native read tool reads the synchronized files. */
export function createWorldbookSkillProvider({ load, directory, catalog = createWorldbookSkillCatalog(), resourcesAvailable = () => true, inlineTokenBudget = 2000 }) {
  if (!Number.isSafeInteger(inlineTokenBudget) || inlineTokenBudget < 0) throw new Error('Invalid inline Skill token budget')
  if (!directory) throw new Error('Worldbook Skill output directory is required')
  const files = createWorldbookSkillFiles(directory)
  const provider = 'tavern-worldbook'
  const scopes = new WeakMap()
  const owners = new Map()
  const release = key => {
    const count = (owners.get(key) || 1) - 1
    if (count > 0) owners.set(key, count)
    else { owners.delete(key); catalog.dispose(key) }
  }
  const collected = new FinalizationRegistry(release)
  function track(scope, key) {
    if (!scope || typeof scope !== 'object') return
    const previous = scopes.get(scope)
    if (previous === key) return
    if (previous) { collected.unregister(scope); release(previous) }
    if (key) { scopes.set(scope, key); owners.set(key, (owners.get(key) || 0) + 1); collected.register(scope, key, scope) }
    else scopes.delete(scope)
  }
  async function stateFor(lookup) {
    lookup?.signal?.throwIfAborted()
    if (!lookup?.scope?.session?.id) return null
    const state = await load(lookup.scope)
    if (state) { sourceEntries.delete(state); sourceKeys.delete(state) }
    const allowed = (state?.authorizedSessionId || state?.chat?.sessionId) === lookup.scope.session.id && state.chat.worldbookStrategy === 'native-skills' && resourcesAvailable(lookup.scope)
    track(lookup.scope, allowed ? scopeKey(state) : null)
    return allowed ? state : null
  }
  function candidate(state, cluster) {
    const key = scopeKey(state)
    const directory = path.join(files.directory(key), clusterDirectory(cluster))
    return {
      name: cluster.skillName,
      description: discoveryDescription(cluster),
      invocation: { modelInvocable: true, userInvocable: false }, source: provider, provider, rank: 600,
      locator: { sessionId: state.chat.sessionId, scopeKey: key, clusterId: cluster.id },
      resourceBase: { kind: 'directory', path: directory },
      metadata: { worldbook: { inline: cluster.inline, estimatedTokens: cluster.estimatedTokens, refs: cluster.refs, keywords: cluster.keywords, book: state.worldBook.view.displayName } }
    }
  }
  function discoveryDescription(cluster) {
    const description = cluster.inline ? cluster.description.replace('按资料链接查阅原文。', '') : cluster.description
    const chars = Array.from(description)
    return chars.length <= 100 ? description : chars.slice(0, 99).join('') + '…'
  }
  const layouts = new WeakMap()
  const publishedNames = new Map()
  const sourceIdentity = source => source?.kind === 'merged'
    ? ['merged', (source.sources || []).map(sourceIdentity)]
    : [source?.kind || '', source?.cardPath || source?.path || '']
  const familyKey = state => digest(JSON.stringify([state.chat.cardPath, state.worldBook?.mergedSources
    ? state.worldBook.mergedSources.map(book => sourceIdentity(book.source)) : sourceIdentity(state.worldBook?.source)]))
  function entryIdentity(state, entry) {
    if (entry.plugin) return entry.ref
    const origin = state.worldBook?.mergedSources?.find(book => book.entries.some(item => String(item.uid) === String(entry.sourceUid)))
    const uid = origin?.entries.find(item => String(item.uid) === String(entry.sourceUid))?.originalUid ?? entry.sourceUid ?? entry.ref
    return JSON.stringify([sourceIdentity(origin?.source || state.worldBook?.source), uid])
  }
  function identities(state) {
    return entriesOf(state).map(entry => ({ ref: entry.ref, identity: entryIdentity(state, entry) }))
  }
  function previousLayout(scope, family, state) {
    const cached = layouts.get(scope)
    const saved = cached?.family === family ? cached : [...sessionEvents(scope?.session)].reverse()
      .find(event => event.data?.source?.worldbookSkills?.family === family)?.data.source.worldbookSkills
    if (!saved) return []
    const old = new Map((saved.identities || []).map(entry => [entry.ref, entry.identity]))
    const current = new Map(identities(state).map(entry => [entry.identity, entry.ref]))
    return (saved.clusters || saved.layout || []).map(cluster => ({ ...cluster,
      refs: cluster.refs.map(ref => current.get(old.get(ref))).filter(ref => ref !== undefined) }))
  }
  const operations = new Map()
  async function current(lookup) {
    const id = lookup?.scope?.session?.id || ''
    const job = (operations.get(id) || Promise.resolve()).catch(() => {}).then(() => buildCurrent(lookup))
    operations.set(id, job)
    try { return await job } finally { if (operations.get(id) === job) operations.delete(id) }
  }
  async function buildCurrent(lookup) {
    // Edits during the worker build cannot authorize the old result. Retry only
    // while the caller remains live; each generation is cancelled by catalog.update.
    for (;;) {
      const state = await stateFor(lookup)
      if (!state) {
        return null
      }
      const version = versionOf(state), key = scopeKey(state)
      const family = familyKey(state), previous = previousLayout(lookup.scope, family, state)
      let compiled = await abortable(catalog.update(key, entriesOf(state), { previousClusters: previous }), lookup?.signal)
      lookup?.signal?.throwIfAborted()
      const latest = await stateFor(lookup)
      if (!latest) return null
      if (scopeKey(latest) !== key || versionOf(latest) !== version) continue
      compiled = { ...compiled, clusters: nameWorldbookSkillDirectories(compiled.clusters.map(cluster => ({ ...cluster, previousTitle: cluster.title, ...describeWorldbookCluster(members(latest, cluster)), ...layout(members(latest, cluster)) })), publishedNames.get(key) || previous) }
      publishedNames.set(key, compiled.clusters.map(({ id, directoryName, skillName }) => ({ id, directoryName, skillName })))
      const cardName = latest.chat.cardPath ? path.parse(latest.chat.cardPath).name : latest.worldBook.view.displayName
      await files.assign(key, cardName || '世界书', { legacyKey: legacyScopeKey(latest), versioned: true })
      const prepared = documents(latest, compiled)
      await files.sync(key, prepared)
      const verified = await stateFor(lookup)
      if (!verified || scopeKey(verified) !== key || versionOf(verified) !== version) {
        if (!verified) return null
        continue
      }
      layouts.set(lookup.scope, { family, identities: identities(verified), clusters: compiled.clusters.map(({ id, refs, keywords, title, description, directoryName, skillName }) => ({ id, refs, keywords, title, description, directoryName, skillName })) })
      return { state: verified, compiled, documents: prepared }
    }
  }
  const versions = new WeakMap()
  const snapshots = new WeakMap()
  function layout(entries) {
    const estimatedTokens = entries.reduce((n, entry) => n + estimateWorldBookTokens(entry.content), 0)
    return { estimatedTokens, inline: inlineTokenBudget > 0 && estimatedTokens <= inlineTokenBudget }
  }
  function guide(state, cluster) {
    const item = candidate(state, cluster)
    const entries = members(state, cluster)
    const label = value => text(value).replace(/[\[\]\\]/g, '\\$&')
    return `---\nname: ${item.name}\ndescription: ${JSON.stringify(cluster.description)}\n---\n\n# ${cluster.title}\n\n` + (cluster.inline
      ? entries.map(entry => `## ${worldbookEntryTitle(entry)}\n\n${String(entry.content ?? '')}\n`).join('\n')
      : entries.map(entry => `- [${label(worldbookEntryTitle(entry))}](${referenceFile(entry, entries)})`).join('\n') + '\n')
  }
  function documents(state, compiled) {
    const output = new Map()
    for (const cluster of compiled.clusters) {
      const base = clusterDirectory(cluster)
      output.set(`${base}/SKILL.md`, guide(state, cluster))
      const entries = members(state, cluster)
      if (!cluster.inline) for (const entry of entries) output.set(`${base}/${referenceFile(entry, entries)}`, String(entry.content ?? ''))
    }
    return output
  }
  async function resource(resourcePath, lookup) {
    const result = await current(lookup)
    if (!result || !path.isAbsolute(resourcePath) || path.normalize(resourcePath) !== resourcePath) return undefined
    const base = files.directory(scopeKey(result.state))
    const relative = path.relative(base, resourcePath).split(path.sep).join('/')
    if (!result.documents.has(relative)) return undefined
    await files.verify(resourcePath, result.documents.get(relative))
    return resourcePath
  }
  return {
    name: provider,
    directory: files.root,
    ownsPath(resourcePath) {
      const relative = path.relative(files.root, path.resolve(String(resourcePath || '')))
      return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
    },
    async authorizeRead(resourcePath, lookup) { return Boolean(await resource(resourcePath, lookup)) },
    async removeChat() {
      // These are source-owned bundles. Deleting a chat must not remove files
      // still used by another chat or its saved source snapshot.
    },
    async refresh(scope, { signal } = {}) {
      if (!scope || typeof scope !== 'object') return false
      const result = await current({ scope, signal })
      const candidates = result ? result.compiled.clusters.map(cluster => candidate(result.state, cluster)) : []
      const snapshot = result ? { directory: files.directory(scopeKey(result.state)), entries: entriesOf(result.state).map(entry => ({ ref: entryIdentity(result.state, entry), title: worldbookEntryTitle(entry), hash: digest(JSON.stringify([worldbookEntryTitle(entry), entry.content, entry.primaryKeys, entry.secondaryKeys])) })) } : { directory: '', entries: [] }
      snapshot.version = digest(JSON.stringify(snapshot))
      if (result) { snapshot.family = familyKey(result.state); snapshot.layout = layouts.get(scope)?.clusters || []; snapshot.identities = layouts.get(scope)?.identities || [] }
      snapshots.set(scope, snapshot)
      const version = JSON.stringify(candidates), previous = versions.get(scope)
      versions.set(scope, version)
      return previous === undefined ? candidates.length > 0 : previous !== version
    },
    changeSnapshot(scope) { return snapshots.get(scope) },
    async inspect(lookup) {
      const result = await current(lookup)
      if (!result) return null
      const entries = entriesOf(result.state)
      return { directory: files.directory(scopeKey(result.state)), book: result.state.worldBook.view.displayName, metrics: result.compiled.metrics, inlineTokenBudget,
        clusters: result.compiled.clusters.map(cluster => {
          const item = candidate(result.state, cluster)
          return { name: item.name, legacyName: `wb-${legacyScopeKey(result.state)}-${cluster.id}`, title: cluster.title, inline: cluster.inline, estimatedTokens: cluster.estimatedTokens, keywords: cluster.keywords, guide: guide(result.state, cluster), directory: item.resourceBase.path,
            entries: entries.filter(entry => cluster.refs.includes(entry.ref)).map(entry => ({
              ref: entry.ref, inline: cluster.inline, inlineText: cluster.inline ? `## ${worldbookEntryTitle(entry)}\n\n${String(entry.content ?? '')}\n` : undefined, title: worldbookEntryTitle(entry),
              source: entry.sourcePath, uid: entry.sourceUid,
              path: path.join(item.resourceBase.path, cluster.inline ? 'SKILL.md' : referenceFile(entry, members(result.state, cluster))),
              previousIdPath: path.join(item.resourceBase.path, legacyReferenceFile(entry, members(result.state, cluster))),
              referencePath: path.join(item.resourceBase.path, referenceFile(entry, members(result.state, cluster))),
              previousRootPath: path.join(files.root, legacyScopeKey(result.state), clusterDirectory(cluster), legacyReferenceFile(entry, members(result.state, cluster))),
              previousPath: path.join(files.root, legacyScopeKey(result.state), `${skillFileLabel(cluster.previousTitle)}--${cluster.id}`, legacyReferenceFile(entry, members(result.state, cluster))),
              previousShortPath: path.join(files.root, legacyScopeKey(result.state), skillFileLabel(cluster.previousTitle.replace(/[\s·]+/g, '、')), legacyReferenceFile(entry, members(result.state, cluster))),
              legacyPath: `${WORLDBOOK_SKILL_RESOURCE_ROOT}${legacyScopeKey(result.state)}/${cluster.id}/entries/${digest(entry.ref)}.md`
            })) }
        }) }
    },
    async list(lookup) {
      const result = await current(lookup)
      return { candidates: result ? result.compiled.clusters.map(cluster => candidate(result.state, cluster)) : [], complete: true }
    },
    async get(previous, lookup) {
      const result = await current(lookup)
      if (!result || previous.locator?.sessionId !== result.state.chat.sessionId || previous.locator.scopeKey !== scopeKey(result.state)) return undefined
      const cluster = result.compiled.clusters.find(item => item.id === previous.locator.clusterId)
      if (!cluster) return undefined
      const fresh = candidate(result.state, cluster)
      if (fresh.name !== previous.name) return undefined
      const file = path.join(fresh.resourceBase.path, 'SKILL.md')
      await files.verify(file, guide(result.state, cluster))
      return { ...fresh, content: (await fs.readFile(file, 'utf8')).replace(/^---\n[\s\S]*?\n---\n/, '') }
    },
    async readEntry(ref, lookup) {
      const result = await current(lookup)
      const entry = result && entriesOf(result.state).find(entry => entry.ref === ref)
      return entry ? String(entry.content ?? '') : undefined
    },
    async readResource(resourcePath, lookup) {
      const file = await resource(resourcePath, lookup)
      return file ? fs.readFile(file, 'utf8') : undefined
    },
    dispose(scope) {
      if (scope) { track(scope, null); versions.delete(scope); snapshots.delete(scope); layouts.delete(scope) }
      else { catalog.dispose(); owners.clear(); publishedNames.clear() }
    }
  }
}
