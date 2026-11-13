import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'

// 真实执行 BodyEditPanel（features/play-turn-actions.js）的保存流程：在 JSDOM + 真实 React 里挂载
// 正式组件，经正式入口（「编辑正文」按钮的 getBodyEdit，或用户输入编辑模块发出的页面事件）打开面板，
// 点击「保存」后核对它发出的 RPC 参数与页面副作用。只有 rpc 是可注入错误的替身，保存代码本身不替换。
// React 的输入事件特性探测发生在模块加载时，所以先准备页面 DOM 再加载 React。
const bootstrap = new JSDOM('<main></main>', { pretendToBeVisual: true })
Object.assign(globalThis, { window: bootstrap.window, document: bootstrap.window.document, IS_REACT_ACT_ENVIRONMENT: true })
const React = (await import('react')).default
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')

const playTurnActionsSource = await readFile(new URL('../tavern-plugin/src/client/features/play-turn-actions.js', import.meta.url), 'utf8')
const panelSource = playTurnActionsSource.slice(
	playTurnActionsSource.indexOf('const bodyEditPanel ='),
	playTurnActionsSource.indexOf('// @include modules/background-wait.js')
)

const SESSION = 'game-1'
const CONFLICT = '正文或会话已变化，请重新打开编辑'
const storyEdit = (extra = {}) => ({ token: 'token-1', role: 'assistant', index: 4, turn: 3, seq: 40, messageIndex: 4, revision: 7, messageUid: 'm3',
	parts: [{ kind: 'text', text: '原正文' }, { kind: 'html' }, { kind: 'text', text: '第二段' }], ...extra })
const nativeEdit = (extra = {}) => ({ token: 'token-u', role: 'user', index: 1, turn: 5, seq: 42, parts: [{ kind: 'text', text: '原输入' }], ...extra })

function createPage(t, { replies = {} } = {}) {
	const dom = new JSDOM('<main></main>', { pretendToBeVisual: true })
	Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
	const roots = [], calls = [], effects = [], reports = []
	t.after(async () => {
		for (const root of roots) await act(async () => root.unmount())
		dom.window.close()
	})
	// 只替换 RPC 传输：按方法名回放预设结果或注入错误，记录每次调用的参数。
	async function rpc(method, args, sessionId) {
		calls.push({ method, args: structuredClone(args), sessionId })
		const reply = replies[method]
		if (reply === undefined) throw new Error('测试未预设的 RPC：' + method)
		const value = typeof reply === 'function' ? await reply(args, calls.filter(call => call.method === method).length) : reply
		if (value instanceof Error) throw value
		return value
	}
	const context = vm.createContext({
		React, console, window: dom.window, document: dom.window.document, CustomEvent: dom.window.CustomEvent, rpc,
		liveTavernView: { setView: (id, view) => effects.push(['setView', id, view]), invalidate: id => effects.push(['invalidate', id]) },
		tavernCoordination: { invalidate: id => effects.push(['coordination', id]) },
		notifyTavernDataChanged: (kinds, source) => effects.push(['dataChanged', kinds, source]),
		tavernPlayEvents: { emit: (type, id, fields) => effects.push(['play', type, id, fields]), editChars: (before, after) => (before === after ? 0 : Math.max(before.length, after.length)) },
		tavernErrorHub: { report: (title, error) => reports.push([title, String(error && error.message || error)]) },
		useLiveTavernView: () => ({ view: { canEditBody: true } }), latestTavernAssistantMessageId: () => 'a1',
		setRegenPanel() {}, setCandidatePanel() {}, setCandidateGuidePanel() {}
	})
	const exported = vm.runInContext(panelSource + '\n;({ BodyEditPanel: BodyEditPanel, TavernEditBodyAction: TavernEditBodyAction })', context)
	const mutated = []
	dom.window.addEventListener('dsh-tavern-story-mutated', event => mutated.push(JSON.parse(JSON.stringify(event.detail))))
	const drafts = []
	const props = { sessionId: SESSION, useSession: select => select({ running: false }), useChat: select => select({}), inputActions: { setDraft: text => drafts.push(text) } }
	async function mount(withAction = false) {
		const root = createRoot(dom.window.document.querySelector('main'))
		await act(async () => root.render(React.createElement(React.Fragment, null,
			withAction ? React.createElement(exported.TavernEditBodyAction, props) : null,
			React.createElement(exported.BodyEditPanel, props))))
		roots.push(root)
	}
	const document = dom.window.document
	const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set
	return {
		dom, calls, effects, reports, mutated, drafts, mount,
		// 用户输入编辑模块打开本面板的正式页面事件。
		open: (edit, texts) => act(async () => dom.window.dispatchEvent(new dom.window.CustomEvent('dsh-tavern-open-body-edit', { detail: { sessionId: SESSION, edit, texts } }))),
		panel: () => document.querySelector('.fork-body-edit'),
		error: () => document.querySelector('.fork-body-edit [role="alert"]')?.textContent ?? null,
		status: () => document.querySelector('.fork-body-edit [role="status"]')?.textContent ?? null,
		primary: () => document.querySelector('.fork-body-edit .dsh-tavern-question-primary'),
		save: () => act(async () => document.querySelector('.fork-body-edit .dsh-tavern-question-primary').click()),
		type: (index, value) => act(async () => {
			const area = document.querySelectorAll('.fork-body-edit textarea')[index]
			setter.call(area, value)
			area.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
		}),
		saves: () => calls.filter(call => call.method === 'saveBodyEdit').map(call => call.args),
		methods: () => calls.map(call => call.method)
	}
}

test('保存携带消息身份（messageUid / messageIndex / revision）与令牌，成功后关闭面板并广播 story-mutated', async t => {
	const view = { mode: 'story', latestAssistantTurn: 3 }
	const page = createPage(t, { replies: { getBodyEdit: { edit: storyEdit() }, saveBodyEdit: { view } } })
	await page.mount(true)
	// 正式入口：「编辑正文」按钮读取可编辑内容后打开面板。
	await act(async () => page.dom.window.document.querySelector('button[role="menuitem"]').click())
	assert.deepEqual(page.calls[0], { method: 'getBodyEdit', args: {}, sessionId: SESSION })
	assert.ok(page.panel())
	assert.equal(page.dom.window.document.querySelectorAll('.fork-body-edit textarea').length, 2, 'HTML 片段只显示占位，不可编辑')
	await page.type(0, '改过的正文')
	await page.save()
	assert.deepEqual(page.saves(), [{ token: 'token-1', role: 'assistant', index: 4, turn: 3, seq: 40, messageIndex: 4, revision: 7, messageUid: 'm3', texts: ['改过的正文', '第二段'] }])
	assert.equal(page.calls.at(-1).sessionId, SESSION)
	assert.equal(page.panel(), null, '保存成功后面板关闭')
	assert.deepEqual(page.mutated, [{ sessionId: SESSION }], '保存后广播 story-mutated 让故事列表重读')
	assert.deepEqual(page.effects.filter(item => item[0] === 'setView'), [['setView', SESSION, view]])
	assert.ok(page.effects.some(item => item[0] === 'dataChanged'))
	assert.deepEqual(page.effects.filter(item => item[0] === 'play').map(item => item[1]), ['ai_edit'])
	assert.deepEqual(page.reports, [])
})

test('冲突后按最新 revision 重读一次，仍携带同一 UID，再用新令牌保存', async t => {
	const view = { mode: 'story' }
	const page = createPage(t, { replies: {
		saveBodyEdit: (args, attempt) => attempt === 1 ? new Error(CONFLICT) : { view },
		getStoryTranscript: { storyTranscript: { revision: 9 }, revision: 9 },
		getBodyEdit: args => ({ edit: storyEdit({ token: 'token-2', revision: args.revision, messageUid: args.messageUid }) })
	} })
	await page.mount()
	await page.open(storyEdit(), ['原正文', '第二段'])
	await page.type(1, '改过的第二段')
	await page.save()
	assert.deepEqual(page.methods(), ['saveBodyEdit', 'getStoryTranscript', 'getBodyEdit', 'saveBodyEdit'])
	assert.deepEqual(page.calls[1].args, { sessionId: SESSION })
	assert.deepEqual(page.calls[2].args, { role: 'assistant', messageIndex: 4, revision: 9, messageUid: 'm3' }, '故事重试必须携带 UID 与最新 revision')
	assert.deepEqual(page.saves()[1], { ...page.saves()[0], token: 'token-2', revision: 9 })
	assert.deepEqual(page.saves()[1].texts, ['原正文', '改过的第二段'])
	assert.equal(page.panel(), null)
	assert.deepEqual(page.mutated, [{ sessionId: SESSION }])
})

for (const [name, refreshed] of [
	['同文本的另一 UID', storyEdit({ token: 'token-2', revision: 9, messageUid: 'other' })],
	['可编辑内容（parts）已变化', storyEdit({ token: 'token-2', revision: 9, parts: [{ kind: 'text', text: '原正文' }, { kind: 'html' }, { kind: 'text', text: '被改过的第二段' }] })]
]) {
	test('重读到' + name + '时放弃重试，面板保留原错误', async t => {
		const page = createPage(t, { replies: {
			saveBodyEdit: new Error(CONFLICT), getStoryTranscript: { storyTranscript: { revision: 9 } }, getBodyEdit: { edit: refreshed }
		} })
		await page.mount()
		await page.open(storyEdit(), ['原正文', '第二段'])
		await page.save()
		assert.deepEqual(page.methods(), ['saveBodyEdit', 'getStoryTranscript', 'getBodyEdit'], '不发第二次保存')
		assert.ok(page.panel(), '面板保留')
		assert.equal(page.error(), CONFLICT)
		assert.deepEqual(page.mutated, [], '未保存不广播')
		assert.equal(page.effects.some(item => item[0] === 'setView'), false)
	})
}

test('原生用户输入按 turn+seq 重读后用新令牌重试，不读故事 transcript', async t => {
	const view = { mode: 'story' }
	const page = createPage(t, { replies: {
		saveBodyEdit: (args, attempt) => attempt === 1 ? new Error('输入或会话已变化') : { view },
		getBodyEdit: { edit: nativeEdit({ token: 'token-u2' }) }
	} })
	await page.mount()
	await page.open(nativeEdit(), ['原输入'])
	await page.type(0, '改过的输入')
	await page.save()
	assert.deepEqual(page.methods(), ['saveBodyEdit', 'getBodyEdit', 'saveBodyEdit'])
	assert.deepEqual(page.calls[1].args, { role: 'user', turn: 5, seq: 42 })
	assert.deepEqual(page.saves()[1], { token: 'token-u2', role: 'user', index: 1, turn: 5, seq: 42, messageIndex: undefined, revision: undefined, messageUid: undefined, texts: ['改过的输入'] })
	assert.equal(page.panel(), null)
	assert.deepEqual(page.effects.filter(item => item[0] === 'play').map(item => item[1]), ['input_rewrite'])
})

test('原生用户输入重读后 turn 或 seq 漂移时拒绝重试', async t => {
	const page = createPage(t, { replies: { saveBodyEdit: new Error('输入或会话已变化'), getBodyEdit: { edit: nativeEdit({ token: 'token-u2', seq: 43 }) } } })
	await page.mount()
	await page.open(nativeEdit(), ['原输入'])
	await page.save()
	assert.deepEqual(page.methods(), ['saveBodyEdit', 'getBodyEdit'], 'seq 漂移不发第二次保存')
	assert.equal(page.error(), '输入或会话已变化')
	assert.ok(page.panel())
	assert.deepEqual(page.mutated, [])
})

test('第二次冲突不再循环，直接报错', async t => {
	const page = createPage(t, { replies: {
		saveBodyEdit: new Error(CONFLICT), getStoryTranscript: { storyTranscript: { revision: 9 } },
		getBodyEdit: { edit: storyEdit({ token: 'token-2', revision: 9 }) }
	} })
	await page.mount()
	await page.open(storyEdit(), ['原正文', '第二段'])
	await page.save()
	assert.deepEqual(page.methods(), ['saveBodyEdit', 'getStoryTranscript', 'getBodyEdit', 'saveBodyEdit'])
	assert.equal(page.error(), CONFLICT)
	assert.ok(page.panel())
	assert.deepEqual(page.mutated, [])
})

test('不属于冲突的错误不重读，直接显示', async t => {
	const page = createPage(t, { replies: { saveBodyEdit: new Error('服务端暂时不可用') } })
	await page.mount()
	await page.open(storyEdit(), ['原正文', '第二段'])
	await page.save()
	assert.deepEqual(page.methods(), ['saveBodyEdit'])
	assert.equal(page.error(), '服务端暂时不可用')
	assert.ok(page.panel())
})

test('排队回执不冒充已保存：面板保持打开并说明排队，不广播也不写视图', async t => {
	const page = createPage(t, { replies: { saveBodyEdit: { queued: true } } })
	await page.mount()
	await page.open(storyEdit(), ['原正文', '第二段'])
	await page.save()
	assert.deepEqual(page.methods(), ['saveBodyEdit'])
	assert.ok(page.panel())
	assert.match(page.status(), /已排队/)
	assert.equal(page.primary().textContent, '重新排队')
	assert.deepEqual(page.mutated, [])
	assert.equal(page.effects.some(item => item[0] === 'setView' || item[0] === 'dataChanged'), false)
	assert.deepEqual(page.effects.filter(item => item[0] === 'invalidate'), [['invalidate', SESSION]])
	// 再次编辑文字后不再显示排队说明，保存按钮恢复。
	await page.type(0, '再改一次')
	assert.equal(page.status(), null)
	assert.equal(page.primary().textContent, '保存')
})

test('失败轮输入被撤回时把编辑后的文字交回输入框并广播', async t => {
	const view = { mode: 'story' }
	const page = createPage(t, { replies: { saveBodyEdit: { composerText: '改过的输入', view } } })
	await page.mount()
	await page.open(nativeEdit({ failed: true }), ['原输入'])
	await page.type(0, '改过的输入')
	await page.save()
	assert.equal(page.panel(), null)
	assert.deepEqual(page.drafts, ['改过的输入'])
	assert.deepEqual(page.mutated, [{ sessionId: SESSION }])
	assert.deepEqual(page.effects.filter(item => item[0] === 'setView'), [['setView', SESSION, view]])
})
