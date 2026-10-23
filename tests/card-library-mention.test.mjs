import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../tavern-plugin/src/client/features/card-library.js', import.meta.url), 'utf8')

function registerCardLibrary(modes, appendMention) {
  const tabs = []
  const context = vm.createContext({
    React: { createElement: (type, props) => ({ type, props }) },
    useTavernSessionMode: (sessionId) => modes[sessionId] || '',
  })
  vm.runInContext(source + ';globalThis.cardLibraryFeature = cardLibraryFeature', context)
  const ctx = {
    effect: (register) => register(),
    betterSidebar: {
      registerTab(tab) {
        tabs.push(tab)
        return () => {}
      },
    },
  }
  context.cardLibraryFeature.register({ ctx, appendMention })
  return (props) => tabs[0].component(props).props
}

test('人物卡库只给制卡会话注入真实的引用回调', () => {
  const calls = []
  const render = registerCardLibrary({ card: 'card', play: 'story', script: 'script' }, (...args) => calls.push(args))
  const card = render({ scope: { sessionId: 'card' } })
  assert.equal(typeof card.appendMention, 'function')
  card.appendMention('cards/a.png', '阿青')
  assert.deepEqual(calls, [['card', 'card', 'cards/a.png', '阿青']])
  // 游玩、剧本、模式未知或无会话时不注入回调，人物卡库因此不显示引用按钮。
  for (const sessionId of ['play', 'script', 'unknown', '']) {
    assert.equal(render({ scope: { sessionId } }).appendMention, undefined, sessionId || '无会话')
  }
})

test('宿主未提供引用入口时制卡会话也不注入空回调', () => {
  const render = registerCardLibrary({ card: 'card' }, undefined)
  assert.equal(render({ scope: { sessionId: 'card' } }).appendMention, undefined)
})
