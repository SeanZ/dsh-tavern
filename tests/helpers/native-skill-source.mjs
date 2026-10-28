// Opt-in source integration: execute real native registry, scope, tool and Cordis
// code without installing a host or making model calls. No native logic is mocked.
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

export async function nativeSkillSource(root) {
  const file = relative => pathToFileURL(path.join(root, relative)).href
  const aliases = {
    '@deepseek-ai/cordis': 'vendor/cordis/src/index.ts',
    '@deepseek-ai/cosmokit': 'vendor/cosmokit/src/index.ts',
    '@deepseek-ai/schemastery': 'vendor/schemastery/src/index.ts',
    '@deepseek-ai/dsh-skill': 'packages/skill/skill/src/index.ts',
    '@deepseek-ai/dsh-scope': 'packages/core/scope/src/index.ts',
    '@deepseek-ai/dsh-util-values': 'packages/util/values/src/index.ts',
    '@deepseek-ai/dsh-util-crypto': 'packages/util/crypto/src/index.ts',
    '@deepseek-ai/dsh-brand': 'packages/util/brand/src/index.ts',
    '@deepseek-ai/dsh-tools': 'packages/core/tools/src/index.ts',
    // Only re-export the real native leaf exports consumed by this composition,
    // avoiding unrelated provider/remote-service boot dependencies.
    '@deepseek-ai/dsh-sandbox': 'packages/sandbox/sandbox/src/index.ts',
    '@deepseek-ai/dsh-util-code-language': 'packages/util/code-language/src/index.ts',
    '@deepseek-ai/dsh-fs': 'packages/fs/fs/src/types.ts',
    '@deepseek-ai/dsh-session': 'packages/core/session/src/types.ts',
  }
  const llm = 'data:text/javascript,' + encodeURIComponent([
    `export * from ${JSON.stringify(file('packages/llm/llm/src/message.ts'))};`,
    `export * from ${JSON.stringify(file('packages/llm/llm/src/error.ts'))};`,
  ].join('\n'))
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === '@deepseek-ai/dsh-llm') return { url: llm, shortCircuit: true }
      if (aliases[specifier]) return { url: file(aliases[specifier]), shortCircuit: true }
      return next(specifier, context)
    },
    load(url, context, next) {
      if (url.startsWith(file('') + '/') && url.endsWith('.ts')) {
        return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true }
      }
      return next(url, context)
    }
  })
  try {
    const [{ Context }, { default: SkillRegistry }, { default: ToolsService }, { default: SystemPrompt }, skillTool, readTool] = await Promise.all([
      import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-skill'), import('@deepseek-ai/dsh-tools'),
      import(file('packages/core/system-prompt/src/index.ts')), import(file('packages/skill/tool-skill/src/index.ts')),
      import(file('packages/fs/tool-fs/src/read.ts')),
    ])
    return { Context, SkillRegistry, ToolsService, SystemPrompt, skillTool, readTool, close: () => hooks.deregister() }
  } catch (error) { hooks.deregister(); throw error }
}
