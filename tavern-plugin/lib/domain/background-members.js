// The named resident background Agents of a game. Each keeps its own Session (and prompt
// cache); tasks on one member run one at a time, tasks on different members may overlap.
// `background` is the Session every game already has, so old saves keep using it.
export const BACKGROUND_MEMBERS = Object.freeze([
  { id: 'background', name: '书记' },
  { id: 'polish', name: '润色师' }
])

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

export function memberName(id) {
  return BACKGROUND_MEMBERS.find(member => member.id === id)?.name || ''
}
