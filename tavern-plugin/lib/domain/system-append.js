import { promptSection } from './prompt-section.js'
// Prepend at assembly time so saved edits also apply to existing sessions.
export function prependSystemInstruction(assembly, text, supportsRetirement = false) {
  const sections = (assembly.sections || []).filter(section => section.name !== 'tavern:system-append')
  const order = Math.min(0, ...sections.map(section => Number.isFinite(section.order) ? section.order : 0)) - 1
  if (typeof text === 'string' && text.trim()) sections.unshift({ name: 'tavern:system-append', order, text: promptSection('system_append', text.trim()) })
  else if (supportsRetirement) sections.unshift({ name: 'tavern:system-append', order, retire: true, text: '本局已移除先前的工作台附加指令。' })
  assembly.sections = sections
  return assembly
}
