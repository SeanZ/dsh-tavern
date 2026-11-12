function installTavernHostChatFlow(slots, renderFlow, onActiveChange) {
	const key = 'conversation.chat.flow'
	return slots.inject(key, function () {
		let activeEntry = null, wrapper = null, dispose = null, installing = false, stopped = false
		function detach() {
			const current = dispose
			dispose = null
			activeEntry = null
			wrapper = null
			if (current) {
				try { current() } finally { onActiveChange(false) }
			}
		}
		function install() {
			if (stopped || installing) return
			const entries = slots.entries(key).filter(entry => entry.component && entry.component !== wrapper)
			const native = entries.find(entry => entry.children && entry.children['conversation.chat.node']) || entries[0]
			if (native === activeEntry) return
			installing = true
			try {
				detach()
				// 带子槽的条目保留宿主提供的 renderSlot 和原生渲染。
				if (!native || native.children !== undefined) return
				const original = native.component
				wrapper = function TavernHostChatFlow(props) {
					return renderFlow(props, () => React.createElement(original, props))
				}
				const registration = { name: key, priority: -1, registrant: 'dsh-tavern' }
				for (const field of ['inject', 'store', 'locale']) if (native[field] !== undefined) registration[field] = native[field]
				dispose = slots.register(registration, wrapper)
				activeEntry = native
				onActiveChange(true)
			} finally { installing = false }
		}
		const unsubscribe = typeof slots.subscribe === 'function' ? slots.subscribe(key, install) : () => {}
		function stop() {
			if (stopped) return
			stopped = true
			try { unsubscribe() } finally { detach() }
		}
		try { install() } catch (error) { stop(); throw error }
		return stop
	})
}
