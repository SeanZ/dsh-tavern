import test from 'node:test'
import assert from 'node:assert/strict'

import { proxyEnvironment, applySystemProxy, describeProxy } from '../bin/system-proxy.mjs'

// exec 的签名与 execFileSync 一致：exec(command, [args…])
const fakeExec = responses => (command, args = []) => {
  const key = `${command} ${args.join(' ')}`
  const value = responses[key]
  if (value === undefined) throw Object.assign(new Error('command not found'), { code: 'ENOENT' })
  return value
}

const WINDOWS_ON = fakeExec({
  'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings':
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n'
    + '    ProxyEnable    REG_DWORD    0x1\r\n'
    + '    ProxyServer    REG_SZ    127.0.0.1:7890\r\n'
    + '    ProxyOverride  REG_SZ    <local>;*.corp.test\r\n',
})

test('环境变量里已有代理时直接沿用，并补上 NODE_USE_ENV_PROXY', () => {
  const result = proxyEnvironment({ HTTPS_PROXY: 'http://127.0.0.1:1080' }, { platform: 'linux', exec: fakeExec({}) })
  assert.equal(result.source, 'environment')
  assert.deepEqual(result.added, { NODE_USE_ENV_PROXY: '1' })
  assert.equal(describeProxy(result), '使用环境变量里的代理')
})

test('Windows 的 WinINET 系统代理被翻译成 HTTP(S)_PROXY，带 NO_PROXY', () => {
  const result = proxyEnvironment({}, { platform: 'win32', exec: WINDOWS_ON })
  assert.equal(result.source, 'system')
  assert.equal(result.added.HTTP_PROXY, 'http://127.0.0.1:7890')
  assert.equal(result.added.HTTPS_PROXY, 'http://127.0.0.1:7890')
  assert.equal(result.added.NODE_USE_ENV_PROXY, '1')
  assert.match(result.added.NO_PROXY, /localhost/)
  assert.match(result.added.NO_PROXY, /\.corp\.test/)
  assert.equal(result.summary, '127.0.0.1:7890')
})

test('Windows 关闭代理时不臆造环境变量', () => {
  const exec = fakeExec({
    'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings':
      '    ProxyEnable    REG_DWORD    0x0\r\n    ProxyServer    REG_SZ    127.0.0.1:7890\r\n',
  })
  assert.deepEqual(proxyEnvironment({}, { platform: 'win32', exec }).added, {})
})

test('Windows 只配置 PAC 或只给 SOCKS 时说明原因，不伪造 HTTP 代理', () => {
  const pac = proxyEnvironment({}, { platform: 'win32', exec: fakeExec({
    'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings':
      '    AutoConfigURL    REG_SZ    http://pac.test/proxy.pac\r\n',
  }) })
  assert.equal(pac.source, 'pac')
  assert.deepEqual(pac.added, {})
  assert.match(pac.summary, /PAC/)

  const socks = proxyEnvironment({}, { platform: 'win32', exec: fakeExec({
    'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings':
      '    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    socks=127.0.0.1:7891\r\n',
  }) })
  assert.equal(socks.source, 'unsupported')
  assert.match(socks.summary, /SOCKS/)
})

test('安卓：读 FlClash 写入的全局 http_proxy', () => {
  const exec = fakeExec({
    'settings get global http_proxy': '127.0.0.1:7890\n',
    'settings get global global_http_proxy_host': 'null\n',
    'settings get global global_http_proxy_port': 'null\n',
  })
  const result = proxyEnvironment({}, { platform: 'android', exec })
  assert.equal(result.source, 'system')
  assert.equal(result.added.HTTPS_PROXY, 'http://127.0.0.1:7890')
})

test('安卓：只有 host/port 时拼起来；代理关闭（:0）不当作代理', () => {
  const split = fakeExec({
    'settings get global http_proxy': ':0\n',
    'settings get global global_http_proxy_host': '127.0.0.1\n',
    'settings get global global_http_proxy_port': '7890\n',
  })
  assert.equal(proxyEnvironment({}, { platform: 'android', exec: split }).added.HTTPS_PROXY, 'http://127.0.0.1:7890')

  const off = fakeExec({ 'settings get global http_proxy': ':0\n' })
  assert.deepEqual(proxyEnvironment({}, { platform: 'android', exec: off }).added, {})
})

test('安卓：没有 settings 命令时安静地当作没有系统代理', () => {
  assert.deepEqual(proxyEnvironment({}, { platform: 'android', exec: fakeExec({}) }).added, {})
})

test('Linux：GNOME 手工代理被识别，自动模式不认', () => {
  const manual = fakeExec({
    'gsettings get org.gnome.system.proxy mode': "'manual'\n",
    'gsettings get org.gnome.system.proxy.https host': "'127.0.0.1'\n",
    'gsettings get org.gnome.system.proxy.https port': '7890\n',
  })
  assert.equal(proxyEnvironment({}, { platform: 'linux', exec: manual }).added.HTTPS_PROXY, 'http://127.0.0.1:7890')

  const auto = fakeExec({ 'gsettings get org.gnome.system.proxy mode': "'auto'\n" })
  assert.deepEqual(proxyEnvironment({}, { platform: 'linux', exec: auto }).added, {})
})

test('applySystemProxy 只填充缺失的变量，不覆盖用户设置', () => {
  const env = { HTTPS_PROXY: 'http://user-proxy:8080' }
  const result = applySystemProxy(env, { platform: 'win32', exec: WINDOWS_ON })
  assert.equal(result.source, 'environment')
  assert.equal(env.HTTPS_PROXY, 'http://user-proxy:8080')
})

test('applySystemProxy 把系统代理写进传入的 env（供子进程继承）', () => {
  const env = {}
  const result = applySystemProxy(env, { platform: 'android', exec: fakeExec({
    'settings get global http_proxy': '127.0.0.1:7890\n',
  }) })
  assert.equal(result.source, 'system')
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7890')
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890')
  assert.equal(env.NODE_USE_ENV_PROXY, '1')
})
