// 固定侧栏包的团队接口适配。生成内嵌分发文件，不修改宿主或依赖安装目录。
export function teamProjectionOf(projections, rootId) {
  if (rootId === undefined) return undefined
  const team = projections?.[rootId]?.values.agentTeam
  return team?.enabled === false ? undefined : team
}

export function teamMembersOf(team, live, byId, catalogs, rootId) {
  if (team === undefined) return []
  const members = []
  const add = (member, ownerKey) => members.push({
    ...member, ownerKey,
    status: memberStatus(member, live, byId),
    diagnostics: member.error === undefined ? [] : [member.error],
  })
  // 旧宿主的显式名单仍按原语义读取；rc.2 的身份与成员来源是子代理目录。
  if (Array.isArray(team.members)) {
    for (const member of team.members) add(member, member.name)
    return members
  }
  if (team.enabled !== true || rootId === undefined) return members
  add({ id: rootId, name: 'lead', role: 'lead', phase: 'active' }, rootId)
  const seen = new Set([rootId])
  const pending = [{ id: rootId, path: '' }]
  while (pending.length) {
    const parent = pending.shift()
    const catalog = catalogs[parent.id]
    if (catalog?.state !== 'ready') continue
    for (const entry of catalog.entries) {
      if (seen.has(entry.id) || entry.mode === 'external' || entry.label?.startsWith('Side: ')
        || byId[entry.id]?.displayTitle?.startsWith('Side: ')) continue
      seen.add(entry.id)
      const path = parent.path === undefined || entry.name === undefined ? undefined
        : parent.path === '' ? entry.name : `${parent.path}/${entry.name}`
      if (entry.mode === 'continuable') add({
        id: entry.id, name: path ?? entry.id, role: 'teammate', phase: 'active',
      }, entry.id)
      pending.push({ id: entry.id, path })
    }
  }
  return members
}

export function taskOwnerKey(task, members) {
  const member = members.find(item => task.ownerId !== undefined ? item.id === task.ownerId : item.name === task.ownerName)
  return member?.ownerKey ?? task.ownerId ?? task.ownerName
}

// 冷页面仅被动读取当前树的投影；宿主合并同一ID的在途请求，不启动子代理。
export function taskCatalogReads(projections, rootId) {
  if (rootId === undefined) return []
  const reads = [], pending = [rootId], seen = new Set()
  while (pending.length) {
    const id = pending.shift()
    if (seen.has(id)) continue
    seen.add(id)
    const snapshot = projections?.[id]
    if (!snapshot || snapshot.state === 'idle') reads.push(id)
    for (const child of snapshot?.values.subagentCatalog ?? []) {
      if (child.mode !== 'external' && !child.label?.startsWith('Side: ')) pending.push(child.id)
    }
  }
  return reads
}

function replaceOnce(source, before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) {
    throw new Error('侧栏团队适配锚点不唯一：' + before.slice(0, 90))
  }
  return source.replace(before, after)
}

export function patchSidebarTeams(source, name) {
  if (!['client.js', 'client-registry.js', 'index.js'].includes(name)) return source
  const marker = '// Tavern rc.2 Tasks 接口适配'
  if (source.includes(marker)) return source
  if (name === 'index.js') {
    source = replaceOnce(source, 'const agent = agents?.get(rootSessionId);', `let agent = agents?.get(rootSessionId);
    // 只有显式写操作才恢复冷会话；查看 Tasks 不激活 Agent。
    if (agent === void 0) {
      const result = await ctx.get("sessionController")?.resolveAgent(rootSessionId);
      if (result?.error) throw result.error;
      agent = result?.agent;
    }`)
    return replaceOnce(source,
      'if (teams.tryMembership(agent) === void 0) throw new SidebarError("team-error", "the tree root leads no team", 404);',
      `${marker}
      if (typeof teams.isEnabled === "function") {
        if (ctx.get("subagents").rootOf(agent) !== agent) throw new SidebarError("team-error", "change tasks from the root Session", 400);
        if (!teams.isEnabled(agent)) throw new SidebarError("team-error", "enable Agent Teams before using the task board", 400);
      } else if (teams.tryMembership(agent) === void 0) throw new SidebarError("team-error", "the tree root leads no team", 404);`)
  }
  // 以固定 region 边界替换完整函数，保留状态叠加函数及已有渲染组件。
  const start = source.indexOf('function teamProjectionOf(')
  const end = source.indexOf('/** One member', start)
  if (start < 0 || end < 0) throw new Error('侧栏团队投影 region 已变化')
  source = source.slice(0, start) + marker + '\n' + [teamProjectionOf, teamMembersOf, taskOwnerKey, taskCatalogReads].map(fn => fn.toString()).join('\n') + '\n\t\t' + source.slice(end)
  const changes = [
    ['const rootSummary = rootId === void 0 ? void 0 : byId[rootId];', `const rootSummary = rootId === void 0 ? void 0 : byId[rootId];
      (0, react.useEffect)(() => {
        if (!active || typeof sessions.refreshProjections !== "function") return;
        for (const id of taskCatalogReads(list.projectionsBySession, rootId)) void sessions.refreshProjections(id).catch(() => {});
      }, [active, rootId, sessions, list.projectionsBySession]);`],
    ['teamMembersOf(team, live, byId), [\n\t\t\t\tteam,', 'teamMembersOf(team, live, byId, catalogs, rootId), [\n\t\t\t\trootId,\n\t\t\t\tcatalogs,\n\t\t\t\tteam,'],
    ['if (task.status === "deleted" || task.ownerName === void 0) continue;\n\t\t\t\tconst nodeId = nodeByOwner.get(task.ownerName);', 'if (task.status === "deleted") continue;\n\t\t\t\tconst nodeId = task.ownerId ?? nodeByOwner.get(task.ownerName);'],
    ['id: `owner:${member.name}`', 'id: `owner:${member.ownerKey}`'],
    ['task.ownerName === ownerFilter), [live, ownerFilter]', 'taskOwnerKey(task, members) === ownerFilter), [live, ownerFilter, members]'],
    ['active: ownerFilter === member.name', 'active: ownerFilter === member.ownerKey'],
    ['current === member.name ? void 0 : member.name', 'current === member.ownerKey ? void 0 : member.ownerKey'],
    ['props.owner === member.name &&', 'props.owner === member.ownerKey &&'],
    ['active: props.owner === member.name', 'active: props.owner === member.ownerKey'],
    ['props.onPick(member.name)', 'props.onPick(member.ownerKey)'],
    ['owner: task.ownerName,', 'owner: taskOwnerKey(task, props.teammates),'],
    ['task.ownerName ?? t("teamTaskUnowned")', 'task.ownerName ?? task.ownerId ?? t("teamTaskUnowned")'],
    ['disabled: props.busy,\n\t\t\t\t\t\tonPick: props.onReassign', 'disabled: props.busy || task.status === "completed",\n\t\t\t\t\t\tonPick: props.onReassign'],
    ['rootId !== void 0 && team !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TeamBoard, {', 'team?.failure !== void 0 && (0, react_jsx_runtime.jsx)("div", { role: "alert", children: team.failure }),\n\t\t\t\t\trootId !== void 0 && team !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TeamBoard, {'],
  ]
  for (const [before, after] of changes) source = replaceOnce(source, before, after)
  return source
}
