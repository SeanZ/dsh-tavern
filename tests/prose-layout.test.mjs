// 自动排版（外观 → 正文排版）：模型整块写下来的正文按句子重新分段，块结构与台词行原样保留。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const client = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')

function slice(from, to) {
  const start = client.indexOf(from)
  const end = client.indexOf(to)
  assert.ok(start >= 0 && end > start, '客户端 bundle 里应有这段源码')
  return client.slice(start, end)
}

const source = slice('const TAVERN_PROSE_DEFAULTS', 'const TAVERN_TEXT_LAYOUT_KEY')

function load() {
  const react = { createElement() {}, useState() { return [0, () => {}] }, useEffect() {} }
  const shape = new Function('React', 'window', 'document', source + '\nreturn { TAVERN_PROSE_DEFAULTS, normalizeTavernProseLayout, layoutTavernProseText, setTavernProseLayout, tavernProseLayoutSettings };')
  return shape(react, { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} }, {})
}

const prose = load()
const layout = (text, options) => prose.layoutTavernProseText(text, options)
const paragraphs = text => text.split('\n\n').filter(part => part.trim() !== '')

test('取值规整：默认开着自动分段、每段两句、不缩进；句数夹在 1..4', () => {
  assert.deepEqual(prose.normalizeTavernProseLayout(null), { paragraphs: true, indent: false, sentences: 2 })
  assert.deepEqual(prose.normalizeTavernProseLayout({ paragraphs: false, indent: true, sentences: 9 }), { paragraphs: false, indent: true, sentences: 4 })
  assert.deepEqual(prose.normalizeTavernProseLayout({ sentences: 0 }), { paragraphs: true, indent: false, sentences: 1 })
  assert.deepEqual(prose.normalizeTavernProseLayout({ sentences: '' }), { paragraphs: true, indent: false, sentences: 2 })
})

test('一整块正文：按句子分段，每段不超过设定的句数', () => {
  const text = '夜色从窗棂上滑下来，落在她的发梢。她抬起头，轻声说：「雨停了，我们走吧。」窗外的水声一层层退下去，像有人在很远的地方翻书。她没有等到回答，只是把伞往他那边斜了斜，自己半边肩膀湿在雨里。他忽然笑了，把手伸进雨里接了接，说别急。'
  const two = paragraphs(layout(text, { sentences: 2 }))
  assert.equal(two.length, 3)
  assert.ok(two[0].startsWith('夜色从窗棂上滑下来'))
  assert.ok(two[0].endsWith('我们走吧。」'), '引号里的句号不切碎')
  assert.ok(two[1].startsWith('窗外的水声'))
  assert.ok(two[2].startsWith('他忽然笑了'))
  assert.equal(paragraphs(layout(text, { sentences: 1 })).length, 5, '每段一句就是逐句分段')
  assert.equal(paragraphs(layout(text, { sentences: 4 })).length, 2)
})

test('边界清楚：短段不拆，已有的空行保留，句数没超上限时原文不动', () => {
  const short = '她笑了笑，把灯关小。'
  assert.equal(layout(short, { sentences: 2 }), short, '一句话的旁白不拆，也不补空行')
  const twoSentences = '她没有等到回答。只是把伞往他那边斜了斜，自己半边肩膀湿在雨里，雨声把话都盖住了。'
  assert.equal(layout(twoSentences, { sentences: 2 }), twoSentences, '两句一段本来就合规，保持原样')
  const written = '第一段只有一句。\n\n第二段也短，但仍然自己成段。\n\n第三段照旧。'
  assert.equal(layout(written, { sentences: 2 }), written, '已经分好段的正文不再改写')
})

test('软换行：句末才断段，句中折行并回同一句；中文不加空格，英文补一个', () => {
  assert.equal(layout('雨停了。\n我们走吧。', { sentences: 1 }), '雨停了。\n\n我们走吧。')
  assert.equal(layout('雨落在窗沿上，\n一声接一声。', { sentences: 2 }), '雨落在窗沿上，一声接一声。')
  assert.equal(layout('She waited.\nThen she left.', { sentences: 1 }), 'She waited.\n\nThen she left.')
  assert.equal(layout('The rain stopped,\nand nobody spoke.', { sentences: 2 }), 'The rain stopped, and nobody spoke.')
})

test('块结构原样保留：代码块、表格、列表、标题、引用、链接定义、缩进代码和台词行', () => {
  const text = [
    '旁白一段，句子接句子，模型忘了分段，这一行本来会挤成一片所以需要拆开。第二句也在这里，说明它够长。第三句收尾，终于结束。',
    '',
    '```js',
    'const a = 1; const b = 2; // 代码不拆',
    'console.log(a + b)',
    '```',
    '',
    '## 小标题',
    '',
    '| 名字 | 情绪 |',
    '| --- | --- |',
    '| 林曦 | 平静 |',
    '',
    '- 列表项一',
    '- 列表项二',
    '',
    '> 引用的旁白，句子也连着句子，但引用块自己不参与分段，保持原样不动。第二句写着写着就长了。',
    '',
    '[ref]: https://example.com/x',
    '',
    '@bubble:linxi|林曦|neutral|[雨停了。我们走吧。]',
    ''
  ].join('\n')
  const laid = layout(text, { sentences: 2 })
  assert.ok(laid.includes('```js\nconst a = 1; const b = 2; // 代码不拆\nconsole.log(a + b)\n```'), '代码块一字不改')
  assert.ok(laid.includes('| 名字 | 情绪 |\n| --- | --- |\n| 林曦 | 平静 |'), '表格不动')
  assert.ok(laid.includes('- 列表项一\n- 列表项二'), '列表不动')
  assert.ok(laid.includes('## 小标题'), '标题不动')
  assert.ok(laid.includes('[ref]: https://example.com/x'), '链接定义不动')
  assert.ok(laid.includes('@bubble:linxi|林曦|neutral|[雨停了。我们走吧。]'), '台词行整行保留')
  assert.ok(laid.includes('> 引用的旁白，句子也连着句子，但引用块自己不参与分段，保持原样不动。第二句写着写着就长了。'), '引用块整行保留')
  assert.ok(laid.startsWith('旁白一段，句子接句子，模型忘了分段，这一行本来会挤成一片所以需要拆开。第二句也在这里，说明它够长。\n\n第三句收尾，终于结束。'), '只有那段散文被拆成两段，其余行原样跟着走')
})

test('Markdown 标记不被切断：强调、行内代码和括号里的句号都留在原处', () => {
  const bold = '他笑了一下。**那句“别急”说得很轻。**外面还在下雨，屋檐上的水一滴一滴往下掉，像有人在数时间。'
  const laid = layout(bold, { sentences: 1 })
  assert.ok(laid.includes('**那句“别急”说得很轻。**'), '强调保持完整，不切出半截标记')
  const balanced = laid.split('\n\n').every(part => (part.match(/\*\*/g) || []).length % 2 === 0)
  assert.equal(balanced, true, '每段的 ** 都配对')
  const inline = '她数着 `a。b` 里的句号。第二个句子终于结束，这一行足够长可以触发拆分，因为字数超了四十。'
  assert.ok(layout(inline, { sentences: 1 }).includes('`a。b`'), '行内代码里的句号不当句子边界')
})

test('关掉自动分段就原样返回；开着时同一段文本重复排版结果不变', () => {
  const text = '一整块正文。句子一句接一句。模型从不空行。三层意思挤在一起，读起来确实很累。'
  assert.equal(layout(text, { paragraphs: false, sentences: 2 }), text)
  const once = layout(text, { sentences: 2 })
  assert.equal(layout(once, { sentences: 2 }), once, '排过一次的结果再排仍是原样')
  assert.equal(layout('', { sentences: 2 }), '')
  assert.equal(layout(null, { sentences: 2 }), '')
})

test('接线：正文渲染走自动分段，段首缩进有对应样式', async () => {
  const cast = slice('function renderTavernDialogueText', '// Cast material (sprites')
  assert.match(cast, /renderText\(layoutTavernProseText\(/)
  assert.match(cast, /if \(segment\.kind === "markdown"\) return renderText\(layoutTavernProseText\(segment\.text\), index\)/)
  const css = await readFile(new URL('../tavern-plugin/lib/client-assets/tavern.css', import.meta.url), 'utf8')
  assert.match(css, /html\[data-dsh-tavern-prose-indent\] \.dsh-tavern-assistant[^\n]*p \{ text-indent: 2em; \}/)
})
