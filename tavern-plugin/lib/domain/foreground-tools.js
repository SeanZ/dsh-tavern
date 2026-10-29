// Foreground tools a game may switch off individually. The settings panel shows
// this catalog; visibleTools filters the mode's list by the stored names.
export const FOREGROUND_TOOL_CATALOG = Object.freeze([
  { name: 'tavern_read_variables', label: '读取变量', description: '只读查询当前变量和结算状态。' },
  { name: 'skill', label: '加载 Skill', description: '按需加载写作或任务 Skill。' },
  { name: 'tavern_read_skill_reference', label: '读取 Skill 参考', description: '读取已加载 Skill 的参考文件。' },
  { name: 'style_reference_submit', label: '文风联想', description: '前台记录本轮笔调参考；还需本局开启文风联想。', modes: ['story'] },
  { name: 'tavern_recall_history', label: '召回历史', description: '按关键词或轮次检索已压缩的历史正文。' },
  { name: 'web_search', label: '联网搜索', description: '联网查找资料；还需本局开启「联网搜索」。' },
  { name: 'web_fetch', label: '读取网页', description: '读取网页正文；需全局开启网页读取，且本局开启联网搜索。' },
  { name: 'tavern_read_script', label: '读取剧本', description: '读取剧本后续内容。', modes: ['script'] },
  { name: 'submit_story', label: '正文提交', description: '用 submit_story 提交正文；还需全局开启「输入走工具调用」或「输出走工具调用」。' }
])

// Plugin tools are not in the static catalog, so these names are accepted as
// tool-name strings; a removed plugin's stale name is harmless.
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,120}$/

export function normalizeDisabledForegroundTools(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(name => typeof name === 'string' && TOOL_NAME.test(name)))].slice(0, 200)
}

/** The mode's tools, in catalog order, for the per-game settings panel. */
export function foregroundToolCatalog(mode) {
  return FOREGROUND_TOOL_CATALOG.filter(tool => !tool.modes || tool.modes.includes(mode))
}

export const NO_FOREGROUND_TOOLS_PROMPT = '<output_method>本轮直接输出正文，不要调用任何工具。已提供的人物卡、世界书和历史就是全部资料。</output_method>'
