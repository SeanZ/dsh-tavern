import test from 'node:test'
import assert from 'node:assert/strict'
import { requestDesktopQuit } from '../tavern-plugin/packages/dsh-profile-bridge/lib/quit.mjs'

test('Unavailable Quit action falls back to manual quit without killing anything', async () => {
  assert.equal(await requestDesktopQuit({ pid: 123, executable: 'app.exe', platform: 'win32' }, {
    run: (...args) => args.at(-1)(new Error('menu unavailable')),
    kill: () => assert.fail('must preserve running work'),
  }), false)
  assert.equal(await requestDesktopQuit({ pid: 1, executable: 'app.exe' }, {
    run: () => assert.fail('invalid parent'),
  }), false)
})
