// Preserve verified legacy fonts before installers replace or prune the release.
// This never downloads: offline upgrades adopt only bytes matching the trusted catalog.
import path from 'node:path'
import { readdir } from 'node:fs/promises'
import { adoptBundledFonts } from '../tavern-plugin/lib/font-assets.js'
import { resolveTavernDataRoot } from '../tavern-plugin/lib/domain/tavern-data.js'

export async function preserveInstallationFonts(app, { dataRoot = resolveTavernDataRoot(), androidBackups = false } = {}) {
  const root = path.resolve(app)
  const bundledRoots = [root, root + '.previous'].map(directory => path.join(directory, 'tavern-plugin', 'fonts'))
  if (androidBackups) {
    // Android's replacement installer retains its old source here until the new
    // profile install succeeds. Only immediate real directories with its fixed
    // prefix qualify; the adopter still verifies every face against pinned hashes.
    const entries = await readdir(path.dirname(root), { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    for (const entry of entries) {
      if (entry.isDirectory() && /^\.dsh-tavern-download\.[a-zA-Z0-9_-]+$/.test(entry.name)) {
        bundledRoots.push(path.join(path.dirname(root), entry.name, 'previous-source', 'tavern-plugin', 'fonts'))
      }
    }
  }
  // A valid old face that cannot be cached must abort destructive cleanup;
  // missing/corrupt faces are skipped by the adopter. Never delete before copying.
  return adoptBundledFonts({ dataRoot, bundledRoots })
}
