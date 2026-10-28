import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { classifyDshVersion, dshRangeLabel } from '../tavern-plugin/lib/domain/host-compatibility.js'

// One release-specific source for bootstrap installers, the launcher and documentation checks.
const compatibility = JSON.parse(readFileSync(new URL('../config/dsh-compatibility.json', import.meta.url), 'utf8'))
export const { adaptedDshVersion, recommendedDesktopVersion, desktopReleasesUrl, recommendedDshaVersion, dshaReleasesUrl } = compatibility
export const { minDshVersion, belowDshVersion } = compatibility
export const blockedDshVersions = compatibility.blockedDshVersions || []
if (classifyDshVersion(adaptedDshVersion, compatibility).status !== 'allowed') throw new Error('DSH 适配版本配置无效：须在支持范围内')

// Bundles whose peer range follows the host line (dsh-better-sidebar 0.28 needs
// ^0.2.1, 0.26 needs ^0.2.0). DSH silently skips a bundle with unmet peers, so
// every allowed host line other than the adapted one names its versions here.
export function hostLinePackages(dshVersion) {
  const line = String(dshVersion || '').match(/^\d+\.\d+\.\d+/)?.[0]
  return (line && compatibility.hostLinePackages?.[line]) || {}
}

export function extractDshVersion(output) {
  const match = String(output || '').match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)
  if (!match) throw new Error('无法识别当前 DSH 版本。')
  return match[1]
}

const STABLE_GUIDE = 'https://github.com/flizzywine/dsh-tavern/blob/stable/README.md#快速开始'

function hostGuidance(host) {
  return host === 'android'
    ? `推荐 DSHA ${recommendedDshaVersion}：${dshaReleasesUrl}`
    : `推荐官方 DeepSeek Harness ${recommendedDesktopVersion}：${desktopReleasesUrl}`
}

// Host versions must be in the supported range and not blocked. CLI owns its private runtime, so it stays exact.
export function dshCompatibilityNotice(currentVersion = '', host = 'desktop') {
  if (host === 'cli') return `命令行版独立安装并使用 DSH ${adaptedDshVersion}，不复用或修改全局 DSH。`
  const allowed = dshRangeLabel(compatibility)
  if (!currentVersion) return `支持的 DSH 版本：${allowed}；${hostGuidance(host)}`
  if (classifyDshVersion(currentVersion, compatibility).status === 'allowed') return `当前 DSH ${currentVersion} 在支持范围内。`
  // DSH 0.1.x hosts (DSHA 0.1.5 and older desktop hosts): say first how to
  // get this release, then that the stable branch keeps serving the current host.
  if (/^0\.1\./.test(currentVersion)) {
    const upgrade = host === 'android'
      ? `先升级到 DSHA ${recommendedDshaVersion}（${dshaReleasesUrl}）`
      : `先安装官方 DeepSeek Harness ${recommendedDesktopVersion}（${desktopReleasesUrl}），打开一次后从托盘退出`
    return `已停止安装，现有酒馆、存档和宿主都没有改动。\n当前宿主是 DSH ${currentVersion}，装不了这个版本（需要 DSH ${allowed}）。\n要用这个版本：${upgrade}，再重新运行安装；原宿主的存档换宿主后按 https://github.com/flizzywine/dsh-tavern/wiki/%E4%BB%8E%E6%97%A7%E9%85%92%E9%A6%86%E7%BB%A7%E6%89%BF%E6%95%B0%E6%8D%AE%EF%BC%88%E6%B5%8B%E8%AF%95%E7%89%88%EF%BC%89 导入。\n想继续用现在的宿主：请改装稳定版，安装方法见 ${STABLE_GUIDE}`
  }
  return `${classifyDshVersion(currentVersion, compatibility).reason}；已停止安装，不会修改宿主版本。支持的版本：${allowed}；${hostGuidance(host)}`
}

export function assertCompatibleDshVersion(currentVersion, host = 'cli') {
  if (host === 'cli') {
    if (currentVersion === adaptedDshVersion) return
    throw new Error(`已停止安装：独立 DSH 版本不符，当前 ${currentVersion || '未知'}，应为 ${adaptedDshVersion}。请重新安装独立运行时：设置 DSH_TAVERN_REINSTALL_RUNTIME=1 后重试安装或更新。`)
  }
  if (classifyDshVersion(currentVersion, compatibility).status === 'allowed') return
  throw new Error(dshCompatibilityNotice(currentVersion, host))
}

// Installers run this from a temp directory whose path may be a symlink (macOS
// /var -> /private/var); compare real paths or the command silently does nothing.
let isEntryPoint = false
try { isEntryPoint = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch {}
if (isEntryPoint) {
  if (process.argv[2] === '--check') {
    // A refusal is an expected outcome: print the guidance, not a Node stack trace.
    try {
      const version = extractDshVersion(process.argv[4])
      assertCompatibleDshVersion(version, process.argv[3])
      if (process.argv[3] !== 'cli') console.log(dshCompatibilityNotice(version, process.argv[3]))
    } catch (error) {
      console.error(error.message)
      process.exit(1)
    }
  } else {
    console.log(process.argv[2] === '--version' ? adaptedDshVersion : dshCompatibilityNotice('', process.argv[3] || 'desktop'))
  }
}
