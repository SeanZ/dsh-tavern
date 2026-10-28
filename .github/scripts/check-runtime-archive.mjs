import { stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Decimal bytes, deliberately below the CDN's 20 MB per-file limit.
export const MAX_RUNTIME_ARCHIVE_BYTES = 20_000_000
export async function checkRuntimeArchive(file) {
  const info = await stat(file)
  if (!info.isFile() || info.size <= 0 || info.size >= MAX_RUNTIME_ARCHIVE_BYTES) {
    throw new Error(`Runtime ZIP must be nonempty and smaller than ${MAX_RUNTIME_ARCHIVE_BYTES} bytes; got ${info.size}`)
  }
  return info.size
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Runtime ZIP: ${await checkRuntimeArchive(process.argv[2])} bytes (< ${MAX_RUNTIME_ARCHIVE_BYTES})`)
}
