// Put a DSH card (or CHARX) behind its cover PNG: 大肥鱼.dshcard → 大肥鱼.dshcard.png. The result is the cover
// picture (so systems and chat apps show it as the file's icon) carrying the card as chara/ccv3 for other
// tavern apps, followed by the archive unchanged; Tavern imports the whole archive from it.
// The cover is the card's own icon asset unless --cover names a picture; JPEG and WebP become PNG.
//
//   node examples/dshcard-png.mjs 大肥鱼.dshcard [大肥鱼.dshcard.png] [--cover cover.png]
//
// Sending the file as a picture in chat apps that recompress images drops the card: send it as a file.
import { readFile, writeFile } from 'node:fs/promises'
import { openZipFile } from '../tavern-plugin/lib/domain/zip-file.js'
import { pngCardTextChunk, pngWithTextChunks } from '../tavern-plugin/lib/domain/card-assets.js'
import { stripPngTextChunks } from '../tavern-plugin/lib/domain/file-resources.js'
import { coverImageAsPng } from '../tavern-plugin/lib/domain/card-cover-image.js'

const args = process.argv.slice(2)
const coverAt = args.indexOf('--cover')
const coverFile = coverAt >= 0 ? args[coverAt + 1] : ''
const [source, target = source + '.png'] = args.filter((arg, index) => !arg.startsWith('--') && (coverAt < 0 || index !== coverAt + 1))
if (!source) { console.error('用法：node examples/dshcard-png.mjs <输入.dshcard> [输出.dshcard.png] [--cover 封面图片]'); process.exit(1) }

const archive = await readFile(source)
const zip = await openZipFile(source, { label: source })
let card, cover
try {
  if (zip.prefix > 0) throw new Error(source + ' 前面已经带着一张图片')
  const cardEntry = zip.entries.get('card.json') || zip.entries.get('card/card.json')
  if (!cardEntry) throw new Error(source + ' 里没有 card.json')
  card = JSON.parse((await zip.readBuffer(cardEntry)).toString('utf8'))
  if (coverFile) cover = await readFile(coverFile)
  else {
    const data = card.data && typeof card.data === 'object' ? card.data : card
    const icon = (Array.isArray(data.assets) ? data.assets : []).find(asset => asset && asset.type === 'icon' && asset.name === 'main' && String(asset.uri || '').startsWith('embeded://'))
    const entry = icon && zip.entries.get(icon.uri.slice('embeded://'.length))
    if (!entry) throw new Error('卡里没有封面（icon/main），请用 --cover 指定一张图片')
    cover = await zip.readBuffer(entry)
  }
} finally { await zip.close() }
cover = await coverImageAsPng(cover)

const text = JSON.stringify(card)
const front = pngWithTextChunks(stripPngTextChunks(cover), [pngCardTextChunk('chara', text), pngCardTextChunk('ccv3', text)])
await writeFile(target, Buffer.concat([front, archive]))
console.log(target + '：封面 ' + Math.round(front.length / 1024) + ' KB + 人物卡 ' + Math.round(archive.length / 1024) + ' KB')
