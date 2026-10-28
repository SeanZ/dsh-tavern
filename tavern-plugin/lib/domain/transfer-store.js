import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Big export bundles wait on disk for one download. A token names the file; taking it hands the
// path to the HTTP route, which deletes it once the response ends. Nothing survives an hour.
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function createTransferExportStore({ root, now = Date.now, ttlMs = 60 * 60 * 1000 }) {
  const dir = path.resolve(root)
  const entries = new Map()

  async function sweep(at = now()) {
    for (const [token, entry] of entries) {
      if (at - entry.at <= ttlMs) continue
      entries.delete(token)
      await rm(entry.file, { force: true }).catch(() => {})
    }
    // A restart forgets the tokens; leftover files are collected by age.
    for (const name of await readdir(dir).catch(() => [])) {
      if (!TOKEN.test(name)) continue
      const file = path.join(dir, name)
      const info = await stat(file).catch(() => null)
      if (info && at - info.mtimeMs > ttlMs) await rm(file, { force: true }).catch(() => {})
    }
  }

  /** Keep a finished bundle for one download; returns the token the page puts in its URL. */
  async function put(buffer, filename) {
    await mkdir(dir, { recursive: true })
    await sweep()
    const token = randomUUID()
    const file = path.join(dir, token)
    await writeFile(file, buffer)
    entries.set(token, { at: now(), file, filename: String(filename || ''), bytes: buffer.length })
    return { token, bytes: buffer.length }
  }

  /** Resolve a token without dropping it: the route needs the path while it streams. */
  function take(token) {
    const entry = entries.get(String(token))
    if (!entry) return null
    if (now() - entry.at > ttlMs) { entries.delete(token); return null }
    return { file: entry.file, filename: entry.filename, bytes: entry.bytes, stream: () => createReadStream(entry.file) }
  }

  async function remove(token) {
    const entry = entries.get(String(token))
    if (!entry) return
    entries.delete(token)
    await rm(entry.file, { force: true }).catch(() => {})
  }

  return Object.freeze({ put, take, remove, sweep, dir })
}
