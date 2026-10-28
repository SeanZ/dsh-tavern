const ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/

/** Small registration seam: strategies choose projection; storage stays unchanged. */
export function createWorldbookStrategies({ legacy, nativeSkills }) {
  const strategies = new Map()
  function register({ id, label, description = '', project }) {
    if (typeof id !== 'string' || !ID.test(id) || id.length > 96) throw new Error('世界书策略编号无效')
    if (typeof label !== 'string' || !label.trim() || typeof description !== 'string' || typeof project !== 'function') throw new Error('世界书策略缺少名称或投影函数')
    if (strategies.has(id)) throw new Error('世界书策略已注册：' + id)
    const entry = { id, label: label.trim(), description, project }
    strategies.set(id, entry)
    return () => { if (strategies.get(id) === entry) strategies.delete(id) }
  }
  register({ id: 'legacy', label: '当前召回（关键词注入）', description: '保留现有世界书召回、冷却和可选筛选行为', project: legacy })
  register({ id: 'native-skills', label: '本局原生 Skill 库', description: '按需发现和读取世界书；常驻与强制条目仍注入', project: nativeSkills })
  return {
    register,
    has: id => strategies.has(id),
    list: () => [...strategies.values()].map(({ id, label, description }) => ({ id, label, description })),
    async project(input) {
      const id = input.chat?.worldbookStrategy || 'legacy'
      // Plugin unload preserves the saved preference while restoring usable legacy behavior.
      const strategy = strategies.get(id) || strategies.get('legacy')
      return strategy.project(input)
    }
  }
}
