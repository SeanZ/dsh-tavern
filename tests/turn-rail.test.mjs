// 轮次导航（modules/turn-rail.js）：按正文行计划画刻度，点了自己滚；缺行时自己往前翻。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'

const source = readFileSync(new URL('../tavern-plugin/src/client/modules/turn-rail.js', import.meta.url), 'utf8')

// 宿主结构：会话滚动区 → 宿主那列刻度 + 「加载更早」+ 若干正文行。
function page(turns, options = {}) {
  const marks = turns.map(turn => `<button class="_9dNBWq_mark${(options.unloaded || []).includes(turn) ? ' _9dNBWq_markUnloaded' : ''}" aria-label="跳转到第 ${turn} 轮"></button>`).join('')
  const rows = (options.rows || []).map(([turn, height]) => `<div data-chat-turn="${turn}" data-row="${turn}"><div data-chat-flow-kind="assistant-step">第 ${turn} 轮正文</div></div>`).join('')
  const dom = new JSDOM(`<body><div data-conversation-scroll><nav aria-label="轮次导航">${marks}</nav><div class="_older"><button type="button">加载更早</button></div>${rows}</div></body>`, { pretendToBeVisual: true })
  const scope = dom.window.document.querySelector('[data-conversation-scroll]')
  const box = { left: 20, right: options.narrow ? 700 : 1200, top: 40, bottom: 640, width: options.narrow ? 680 : 1180, height: 600 }
  scope.getBoundingClientRect = () => box
  for (const [turn, height] of options.rows || []) {
    const row = scope.querySelector('[data-row="' + turn + '"]')
    row.getBoundingClientRect = () => ({ height, width: 400, top: 0, bottom: height, left: 0, right: 400 })
    row.scrollIntoView = () => { scope.dataset.scrolledTo = String(turn) }
  }
  const context = vm.createContext({ window: dom.window, document: dom.window.document })
  vm.runInContext(source, context)
  return { dom, document: dom.window.document, scope, create: context.createTurnRailFilter }
}

const hostHidden = document => document.querySelector('nav[data-dsh-tavern-rail-hidden]') !== null
const tickTurns = document => [...document.querySelectorAll('.dsh-tavern-turn-rail [data-turn]')].map(node => Number(node.getAttribute('data-turn')))

test('行在页面里就滚到那一轮的开头', async t => {
  const { dom, document, scope, create } = page([28, 47], { rows: [[28, 400], [47, 90]] })
  t.after(() => dom.window.close())
  const rail = create(scope)
  rail.apply({ accept: () => true })
  document.querySelector('.dsh-tavern-turn-rail [data-turn="47"]').click()
  await new Promise(resolve => dom.window.setTimeout(resolve, 50))
  assert.equal(scope.dataset.scrolledTo, '47')
  rail.dispose()
})

test('行还没翻出来：自己点「加载更早」，翻到了再滚过去', async t => {
  const { dom, document, scope, create } = page([28], { rows: [] })
  t.after(() => dom.window.close())
  let loads = 0
  const older = scope.querySelector('._older button')
  older.addEventListener('click', () => {
    loads += 1
    // 第二次点击后才把这一轮的行挂出来（模拟一页页翻）。
    if (loads < 2) return
    const row = document.createElement('div')
    row.setAttribute('data-chat-turn', '28')
    row.getBoundingClientRect = () => ({ height: 400, width: 400, top: 0, bottom: 400, left: 0, right: 400 })
    row.scrollIntoView = () => { scope.dataset.scrolledTo = '28' }
    scope.appendChild(row)
  })
  const rail = create(scope)
  rail.apply({ accept: () => true })
  document.querySelector('.dsh-tavern-turn-rail [data-turn="28"]').click()
  await new Promise(resolve => dom.window.setTimeout(resolve, 3800))
  assert.ok(loads >= 2, '翻了两次历史')
  assert.equal(scope.dataset.scrolledTo, '28', '翻到后滚到这一轮开头')
  rail.dispose()
})

test('当前所在的那一轮无论计划怎么说都保留', t => {
  const { dom, document, scope, create } = page([28, 47], { rows: [[28, 400], [47, 90]] })
  t.after(() => dom.window.close())
  document.querySelectorAll('._9dNBWq_mark')[1].setAttribute('aria-current', 'true')
  const rail = create(scope)
  rail.apply({ accept: turn => turn === 28 })
  assert.deepEqual(tickTurns(document), [28, 47])
  rail.dispose()
})
