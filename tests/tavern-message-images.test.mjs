import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sourceFunction } from './fixtures/source-function.mjs'

// Host 0.2.1 exposes message pictures only through the Content Factory; the
// plugin used to call props.renderMessageImages, which no longer exists and
// crashed every user row that carried an attachment.
const messageFrame = readFileSync(new URL('../tavern-plugin/src/client/ui/message-frame.js', import.meta.url), 'utf8')
const renderer = readFileSync(new URL('../tavern-plugin/src/client/features/assistant-renderer.js', import.meta.url), 'utf8')
const render = new Function(sourceFunction(messageFrame, 'renderTavernMessageImages') + '\nreturn renderTavernMessageImages')()
const attachment = { attachmentId: 'probe-image' }

test('旧宿主的 renderMessageImages 仍然可用，两者都缺失时安静降级', () => {
  assert.deepEqual(render({ renderMessageImages: input => ['legacy', input.align] }, [{ attachment }], 'start'), ['legacy', 'start'])
  assert.equal(render({}, [{ attachment }], 'start'), null)
  assert.equal(render({ renderFactorySlot() { throw new Error('must not run') } }, [], 'start'), null)
})
