import { fileURLToPath } from 'node:url'
import { installBundledTavernPlugins } from './bundled-tavern-plugins.mjs'
import { userPluginPaths } from '../tavern-plugin/lib/domain/user-plugins.js'
import { readHostCompatibility } from '../tavern-plugin/lib/domain/host-compatibility.js'
import { resolveTavernDataRoot } from '../tavern-plugin/lib/domain/tavern-data.js'
import { ensureUserExtensions } from '../tavern-plugin/lib/domain/user-extensions.js'

// Host classification only ever reports `allowed` (inside the supported range
// and not blocked) or `blocked`; `verified` is accepted too so the guard keeps working if a future
// check distinguishes an installer-verified host from a runtime-allowed one.
export function isCompatibleHost(compatibility) {
  return compatibility.status === 'allowed' || compatibility.status === 'verified'
}

// Only the standard package bundle mounts this guard. Legacy installers check
// the selected host before installation and retain their existing behavior.
export async function apply() {
  const compatibility = readHostCompatibility()
  if (!isCompatibleHost(compatibility)) throw new Error(compatibility.message)
  await prepareStandardPackage(resolveTavernDataRoot())
}

// 标准插件安装不经过独立启动器，也要安装随包分发的酒馆插件。
export async function prepareStandardPackage(dataRoot) {
  await ensureUserExtensions(dataRoot)
  return installBundledTavernPlugins({
    sourceRoot: fileURLToPath(new URL('../', import.meta.url)),
    dataRoot, profileDir: userPluginPaths(dataRoot).profile,
  })
}
