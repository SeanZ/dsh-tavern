import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { computeContentHash } from '../../tavern-plugin/packages/dsh-asset-library/lib/asset-packs/index.js'
import { writeZip } from '../../tavern-plugin/packages/dsh-asset-library/lib/zip.js'

const MiB = 1024 ** 2, chunksPerTrack = 24, trackCount = 48, bytesPerTrack = chunksPerTrack * MiB + 44
const silence = Buffer.alloc(MiB)
const manifest = { format: 'dsh-asset-pack', schemaVersion: 1, id: '12345678-1234-4123-8123-123456789abc', name: 'Large WAV fixture',
  contentHash: '0'.repeat(64), assets: [], figures: [], sprites: {}, bundles: {}, blobs: {}, files: [] }
const entries = []
for (let i = 0; i < trackCount; i++) {
  const header = Buffer.from('524946460000000057415645666d74201000000001000100401f0000803e0000020010006461746100000000', 'hex')
  header.writeUInt32LE(bytesPerTrack - 8, 4)
  header.writeUInt32LE(bytesPerTrack - 44, 40)
  const firstSample = Buffer.from([i, 0])
  function* wav() {
    yield header; yield firstSample; yield silence.subarray(2)
    for (let j = 1; j < chunksPerTrack; j++) yield silence
  }
  const digest = createHash('sha256')
  for (const chunk of wav()) digest.update(chunk)
  const sha256 = digest.digest('hex'), name = `media/${sha256}.wav`
  entries.push({ path: name, stream: () => Readable.from(wav()) })
  manifest.blobs[sha256] = { ext: 'wav', mime: 'audio/wav', size: bytesPerTrack }
  manifest.files.push({ path: name, size: bytesPerTrack, sha256 })
}
manifest.contentHash = await computeContentHash(manifest)
const file = process.argv[2]
await writeZip(file, [{ path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, ...entries])
process.stdout.write(JSON.stringify({ id: manifest.id, name: manifest.name, contentHash: manifest.contentHash }))
