import { readFileSync, statSync } from 'node:fs'

export const SYSTEM_PROMPT_DEFINITIONS = Object.freeze([
  ['system-append', 'system附加指令', '默认开启，可按需关闭。内容会添加到前台、后台及卡片 Agent 的 system 提示词最前面（位于酒馆预设之前），修改后从下一次请求生效。'],
  ['story', '正文 Agent 核心提示词', '控制普通游玩正文的续写规则。'],
  ['script-story', '剧本模式正文补充', '控制绑定剧本时追加给正文 Agent 的规则。'],
  ['style-reference-recall', '文风联想选段', '开启「文风联想」后，后台每轮按这段要求挑一部笔调相近的小说并摘一段原文。可在这里调整选书范围（如偏好轻小说、某类题材），修改后下一次选段生效。'],
  ['style-reference', '文风联想正文补充', '开启「文风联想」后，追加在后台摘来的小说原文之后，告诉正文 Agent 怎样借鉴。'],
  ['polish', '正文精修原则', '重写面板点「精修」时使用：模型按这份标准审读最后一轮正文，列出修改并直接替换，前后对比在「精修对比」页。可以改审稿标准；末尾要求输出 JSON 修改清单的部分请保留，否则精修无法自动应用。修改后下一次精修生效。'],
  ['candidate-story', '普通剧情候选项', '控制普通剧情候选项的数量、类型和输出格式。'],
  ['candidate-script', '剧本候选项', '控制剧本模式候选项及剧本推进规则。'],
  ['posture-settlement', '姿势状态结算', '控制后台姿势结算的工具提交。'],
  ['story-compaction', '前台上下文压缩', '用于前台手动和自动压缩：把更早的剧情写成摘要，最近 10 轮原文原样附在摘要后。修改后下次压缩生效；后台仍使用 DSH 内置压缩提示词。'],
  ['card-workspace', '卡片 Agent 工作区说明', '仅注入卡片 Agent 的 system。可编辑完整说明；{{resourceRoot}} 自动替换为当前资源根目录，{{projectionPaths}} 自动替换为当前会话的投影文件路径。保存后下一次请求生效。'],
].map(function (item) { return Object.freeze({ name: item[0], label: item[1], description: item[2] }) }))

export const SYSTEM_PROMPT_NAMES = Object.freeze(SYSTEM_PROMPT_DEFINITIONS.map(function (item) { return item.name }))

const knownNames = new Set([...SYSTEM_PROMPT_NAMES,
  'card-reference', 'card-task-edit', 'card-task-extract', 'card-task-script',
  'card-task-worldbook', 'card-task-preset', 'card-task-debug-play'
])

function promptVersion(file) {
  const info = statSync(file, { bigint: true })
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
}

export function createPromptCatalog(directory = new URL('../prompts/', import.meta.url), { read = readFileSync, version = promptVersion } = {}) {
  const cache = new Map()
  return function promptFromFile(name) {
    if (!knownNames.has(name)) throw new Error('未知提示词: ' + String(name))
    const file = new URL(name + '.md', directory)
    const stamp = version(file)
    const previous = cache.get(name)
    if (previous?.stamp === stamp) return previous.text
    const text = read(file, 'utf8').trim()
    if (text === '' && name !== 'system-append') throw new Error('提示词文件不能为空: ' + name + '.md')
    if (version(file) === stamp) cache.set(name, { stamp, text })
    return text
  }
}

export const prompt = createPromptCatalog()

// Built-in 卡片工作台性格; the library itself lives in domain/card-personas.js.
export const CARD_PERSONA_DEFINITIONS = Object.freeze([
  ['zhumi', '猫娘助手 · 煮米'],
  ['editor', '冷静专业编辑'],
  ['roaster', '毒舌吐槽役 · 阿刺'],
].map(function (item) { return Object.freeze({ id: item[0], label: item[1] }) }))

export function cardPersonas(directory = new URL('../prompts/card-personas/', import.meta.url), read = readFileSync) {
  return CARD_PERSONA_DEFINITIONS.map(function (item) { return { id: item.id, label: item.label, text: read(new URL(item.id + '.md', directory), 'utf8').trim() } })
}
