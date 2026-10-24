import Module from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// jsdom → whatwg-url → tr46 requires "punycode/": the trailing slash asks for the
// npm package instead of Node's deprecated built-in. DSH 0.2.1-rc.2 routes bare
// requests from packages inside a Profile (a `dsh plugin add` install) through
// createRequire().resolve.paths("punycode"), which is null for a built-in, so the
// whole Tavern import fails ("resolve.paths ... is not iterable"). Installer copies
// live outside the Profile and never reach that branch. Hand the host the
// package directory instead; every other request passes through untouched.
const installed = Symbol.for('dsh-tavern.punycode-request')

export function routePunycodeRequest(moduleApi = Module) {
  if (moduleApi[installed]) return
  const resolveFilename = moduleApi._resolveFilename
  moduleApi._resolveFilename = function (request, parent, ...rest) {
    if (request === 'punycode/') {
      for (const directory of parent?.paths || []) {
        const candidate = join(directory, 'punycode')
        if (existsSync(join(candidate, 'package.json'))) return resolveFilename.call(this, candidate + '/', parent, ...rest)
      }
    }
    return resolveFilename.call(this, request, parent, ...rest)
  }
  moduleApi[installed] = true
}

routePunycodeRequest()
