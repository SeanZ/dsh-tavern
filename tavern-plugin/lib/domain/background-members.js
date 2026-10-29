// The named resident background Agents of a game. Each keeps its own Session (and prompt
// cache); tasks on one member run one at a time, tasks on different members may overlap.
// `background` is the Session every game already has, so old saves keep using it.
// `timeline`: its Session is bound in the save (timeline.participants[id]), rewound with the
// story, compacted with it and counted as the game's own; a member without it keeps its
// Session itself (润色师: plugin data).
export const BACKGROUND_MEMBERS = Object.freeze([
  { id: 'background', name: '书记', timeline: true },
  { id: 'polish', name: '润色师', timeline: false }
])

// Members whose Sessions the save binds, in table order.
export const TIMELINE_MEMBERS = Object.freeze(BACKGROUND_MEMBERS.filter(member => member.timeline).map(member => member.id))

// Coordinator roles (and runner tasks) by the member whose Session and slot they use.
const ROLE_MEMBER = Object.freeze({
  settlement: 'background',
  ledger: 'background',
  candidate: 'background',
  'character-design': 'background',
  // Retired roles still found in old saves.
  'worldbook-filter': 'background',
  'style-reference': 'background',
  polish: 'polish'
})

export function memberOf(role) {
  return ROLE_MEMBER[String(role || '')] || ''
}

// The timeline participant a role binds: its member, or the role itself when it has none.
export function participantOf(role) {
  return memberOf(role) || String(role || '')
}

// The coordinator slot a role waits for. A plugin task has no resident Session, but it
// writes the reply's variables beside settlement, so it waits for 书记's slot.
export function slotOf(role) {
  return memberOf(role) || (role === 'plugin-task' ? 'background' : String(role || ''))
}

// Members plugins register (tavern.member): `plugin:<owner>:<name>`. Their Sessions are the
// runner's, like 润色师's: not bound in the save, never rewound with the story.
const pluginMembers = new Map()

export function pluginMemberId(owner, name) {
  return 'plugin:' + String(owner) + ':' + String(name)
}

/** Register a plugin's member; returns the function that removes it. */
export function registerPluginMember({ owner, name, title }) {
  const id = pluginMemberId(owner, name)
  if (pluginMembers.has(id)) throw new Error('成员 ' + name + ' 已注册')
  const member = Object.freeze({ id, name: String(title || name), timeline: false, plugin: String(owner) })
  pluginMembers.set(id, member)
  return () => { if (pluginMembers.get(id) === member) pluginMembers.delete(id) }
}

export function pluginMember(id) {
  return pluginMembers.get(String(id || '')) || null
}

/** Built-in members, then plugin members. */
export function listMembers() {
  return [...BACKGROUND_MEMBERS, ...pluginMembers.values()]
}

export function memberName(id) {
  return listMembers().find(member => member.id === id)?.name || ''
}
