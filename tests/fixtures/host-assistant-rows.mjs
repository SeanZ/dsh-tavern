import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'

// 直接使用安装宿主的逐步折叠，避免测试把同一步多条最终正文错误地拼接起来。
const require = createRequire(import.meta.url)
const source = await readFile(require.resolve('@deepseek-ai/dsh-client-ui-chat/client'), 'utf8')
function section(start, end) {
  const from = source.indexOf(start),
    to = source.indexOf(end, from)
  assert.ok(from >= 0 && to > from, '宿主正文折叠实现变化，需要更新测试适配')
  return source.slice(from, to)
}
const scope = {}
vm.runInNewContext(
  section('function toAssistantBlocks(content)', 'function emptyAssistantBlock(blockType)') +
    section('function initialState(turn, step)', 'function registerAssistantConversationNode(ctx)') +
    '\nthis.fold = assistantDefinition;',
  scope,
)

export function hostAssistantRows(events) {
  const groups = new Map()
  for (const event of events) {
    const target = scope.fold.match(event)
    if (!target) continue
    const context = groups.get(target.id) || { matches: [] }
    const match = { event }
    context.matches.push(match)
    if (target.role === 'start') {
      context.start = match
      context.state = scope.fold.start(context, match)
    } else context.state = scope.fold.update(context, match)
    groups.set(target.id, context)
  }
  return [...groups.values()].flatMap((context) => {
    const data = scope.fold.buildLocationData(context, 'step')?.value
    const text = Array.from(data?.blocks || [], (block) => block.text || '').join('')
    return text ? [{ turn: data.turn, step: data.step, kind: 'assistant-step', text }] : []
  })
}
