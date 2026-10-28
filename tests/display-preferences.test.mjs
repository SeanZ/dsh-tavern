import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'
const css = await readFile(new URL('../tavern-plugin/lib/client-assets/tavern.css', import.meta.url), 'utf8')
test('隐藏注入、执行请求和思考时保留正文、工具、错误，关闭后恢复原有折叠状态', () => {
  const dom = new JSDOM(`<style>${css.slice(css.indexOf('/* Presentation only:'))}</style><body>
    <div id="context" data-chat-flow-kind="context">注入内容</div>
    <div id="folded" data-chat-flow-kind="context" hidden>已折叠注入</div>
    <div id="thinking" data-chat-flow-kind="turn-process"><button data-turn-process-tool-calls="0" data-turn-process-subagents="0">已思考</button></div>
    <div id="tools" data-chat-flow-kind="turn-process"><button data-turn-process-tool-calls="1" data-turn-process-subagents="0">工具执行</button></div>
    <div id="answer" data-chat-flow-kind="assistant-step"><details id="reasoning" class="dsh-tavern-assistant-reasoning">思考内容</details><p>正文</p></div>
    <div id="trigger" data-chat-flow-kind="turn-trigger">收到执行请求</div>
    <div id="error" data-chat-flow-kind="turn-error">错误</div></body>`)
  const {document} = dom.window, before = document.body.innerHTML
  const display = id => dom.window.getComputedStyle(document.getElementById(id)).display
  document.documentElement.classList.add('dsh-tavern-hide-process')
  for (const id of ['context', 'thinking', 'reasoning', 'trigger']) assert.equal(display(id), 'none')
  for (const id of ['answer', 'tools', 'error']) assert.notEqual(display(id), 'none')
  document.documentElement.classList.remove('dsh-tavern-hide-process')
  for (const id of ['context', 'thinking', 'reasoning', 'trigger']) assert.notEqual(display(id), 'none')
  assert.equal(display('folded'), 'none')
  assert.equal(document.body.innerHTML, before)
  dom.window.close()
})

test('正文底栏保留宿主复制和酒馆分叉，只藏原生分支与酒馆之外的插件动作', () => {
  const dom = new JSDOM(`<style>${css}</style><body class="dsh-tavern-shell-active">
    <div data-turn-tail="21">
      <div data-slot="conversation.chat.turnTail" style="display:contents"></div>
      <div class="actions">
        <button id="copy" type="button" aria-label="复制">复制</button>
        <div data-slot="conversation.chat.assistant-actions" style="display:contents">
          <button id="fork" type="button" class="dsh-tavern-message-fork" aria-label="从这一轮分叉">分叉</button>
          <button id="feedback" type="button" aria-label="好的回答">反馈</button>
        </div>
        <button id="native-branch" type="button" aria-label="在新对话中分支">在新对话中分支</button>
        <span>19:09</span>
      </div>
    </div></body>`)
  const {document} = dom.window
  const display = id => dom.window.getComputedStyle(document.getElementById(id)).display
  assert.notEqual(display('copy'), 'none', '宿主的复制按钮应该留在正文底栏')
  assert.notEqual(display('fork'), 'none', '酒馆的分叉按钮应该留在正文底栏')
  assert.equal(display('feedback'), 'none', '酒馆之外的插件动作不进入游玩底栏')
  assert.equal(display('native-branch'), 'none', '宿主的原生分支会绕开游戏状态，仍应藏掉')
  dom.window.close()
})


test('系统导航开关恢复中英文原生导航，卸载酒馆后不再隐藏', () => {
  const dom = new JSDOM(`<style>${css}</style><body class="dsh-tavern-shell-active"><nav aria-label="全局面板"></nav><nav aria-label="Global panels"></nav></body>`)
  const navs = [...dom.window.document.querySelectorAll('nav')]
  const displays = () => navs.map(nav => dom.window.getComputedStyle(nav).display)
  assert.deepEqual(displays(), ['none', 'none'])
  dom.window.document.documentElement.classList.add('dsh-tavern-show-system-navigation')
  assert(displays().every(display => display !== 'none'))
  dom.window.document.documentElement.classList.remove('dsh-tavern-show-system-navigation')
  assert.deepEqual(displays(), ['none', 'none'])
  dom.window.document.body.classList.remove('dsh-tavern-shell-active')
  assert(displays().every(display => display !== 'none'))
  dom.window.close()
})
