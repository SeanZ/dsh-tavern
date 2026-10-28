import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Exercise the installed official runtime without requiring its TS checkout.
export async function nativeSkillRuntime(root) {
  const load = name => import(pathToFileURL(path.join(root, '@deepseek-ai', name, 'lib/index.js')).href)
  const [{ Context }, { default: SkillRegistry }, { default: ToolsService }, { default: SystemPrompt }, skillTool, toolFs] = await Promise.all([
    load('cordis'), load('dsh-skill'), load('dsh-tools'), load('dsh-system-prompt'), load('dsh-tool-skill'), load('dsh-tool-fs'),
  ])
  return { Context, SkillRegistry, ToolsService, SystemPrompt, skillTool,
    readTool: { applyReadTool(ctx, caps) { toolFs.apply(ctx, { read: true, readLimit: caps.limit, readMaxLineLength: caps.maxLineLength, readMaxBytes: caps.maxBytes, readStreamMinSize: caps.streamMinSize }) } },
    close() {} }
}
