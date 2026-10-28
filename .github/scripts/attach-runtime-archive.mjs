import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { checkRuntimeArchive } from './check-runtime-archive.mjs'

// Record the published runtime zip in dsh-tavern-runtime.json: installers download it at this
// immutable commit (one request) and fall back to the per-file list when it is unusable.
const [commit, zipFile] = process.argv.slice(2)
if (!/^[0-9a-f]{40}$/i.test(String(commit || ''))) throw new Error('A full archive commit SHA is required')
await checkRuntimeArchive(zipFile)
const bytes = await readFile(zipFile)
const manifest = JSON.parse(await readFile('dsh-tavern-runtime.json', 'utf8'))
manifest.archive = { commit, path: 'runtime.zip', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
await writeFile('dsh-tavern-runtime.json', `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
