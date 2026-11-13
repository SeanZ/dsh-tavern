import { createHash } from 'node:crypto'
import { canonicalJson } from '../../packages/dsh-presentation-protocol/src/asset-pack-json.js'
import { templateMessageFields } from './template-message.js'

export function inputTemplateDigest(row) {
  const data = row?.tavernPluginData || {}
  return Object.fromEntries(templateMessageFields.filter(key => Object.hasOwn(data, key))
    .map(key => [key, createHash('sha256').update(canonicalJson(data[key], { admitted: true })).digest('hex')]))
}

// 模板只能并发更新其自有字段，正文、候选和其他插件数据仍参与冲突检查。
export function preparationMessageContent(row) {
  const { variables, messageUid, displayRuntime, tavernPluginData, ...content } = row
  const other = Object.fromEntries(Object.entries(tavernPluginData || {})
    .filter(([key]) => !templateMessageFields.includes(key)))
  if (Object.keys(other).length) content.tavernPluginData = other
  return content
}

export function preparationTemplateHeaderChange({ path }) {
  if (path[0] === 'tavernPluginMetadata') return true
  if (path[0] !== 'promptTemplateInput' || path[1] !== 'message') return false
  return path[2] === 'variables' || (path[2] === 'tavernPluginData'
    && (path.length === 3 || templateMessageFields.includes(path[3])))
}

// 只应用原始输入自模板执行以来已提交的标记差量，避免旧模板对象整包覆盖新数据。
export function mergeInputTemplateData(prepared, latest, baseline) {
  const data = { ...latest?.tavernPluginData, ...prepared.tavernPluginData }
  const current = inputTemplateDigest(latest)
  for (const key of templateMessageFields) {
    if (Object.hasOwn(baseline, key) === Object.hasOwn(current, key)
      && baseline[key] === current[key]) continue
    if (Object.hasOwn(current, key)) data[key] = structuredClone(latest.tavernPluginData[key])
    else delete data[key]
  }
  const next = { ...prepared }
  if (Object.keys(data).length) next.tavernPluginData = data
  else delete next.tavernPluginData
  return next
}
