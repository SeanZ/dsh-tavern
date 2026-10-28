import { readFileSync, writeFileSync, appendFileSync, rmSync, rmdirSync, lstatSync, realpathSync, openSync, fsyncSync, closeSync, renameSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { waitForExit, switchProfile, relaunchApp } from './helper.mjs'
import { cleanupOwnedProcesses, waitForOwnedExit } from './processes.mjs'

async function performJob(request, options) {
  if (!['relocate', 'uninstall'].includes(request.mode)) return switchProfile(request, options)
  const require = createRequire(import.meta.url)
  const { acquireInstallation } = require('./installation-state.cjs')
  const lease = acquireInstallation({ dshHome: request.home, sourceRoot: request.installation.appDir })
  try {
    const { performInstallation, validateInstallationRequest } = await import('./installation.mjs')
    const fresh = validateInstallationRequest({ home: request.home, stateDir: request.stateDir, activeDir: request.liveDir }, request.mode, { confirmed: true, destination: request.destination })
    if (JSON.stringify(fresh.installation.entries) !== JSON.stringify(request.installation.entries)) throw new Error('安装目录已改变，请刷新后重试。')
    const { assertInstallationIdle } = await import('./installation-processes.mjs')
    await assertInstallationIdle(request)
    if (request.mode === 'uninstall' && lstatSync(request.liveDir).isSymbolicLink()) {
      if (realpathSync(request.liveDir) !== realpathSync(fresh.installation.profileDir)) throw new Error('desktop 入口不是当前酒馆，未修改其他 profile。')
      // Record intent before the two-step desktop restore: a crash here must
      // also fence standalone installers, not only the bridge pending queue.
      const journalFile = join(request.stateDir, 'installation-operation.json')
      const writeRestore = phase => lease.withOwnership(() => {
        const temporary = journalFile + '.restore-' + process.pid + '.tmp'
        const fd = openSync(temporary, 'wx', 0o600)
        try { writeFileSync(fd, JSON.stringify({ schemaVersion: 1, mode: 'uninstall-restore', phase, stamp: request.stamp })); fsyncSync(fd) } finally { closeSync(fd) }
        renameSync(temporary, journalFile)
      })
      writeRestore('preparing')
      try {
        await switchProfile({ ...request, mode: 'unlink' }, { ...options, rename: (from, to) => lease.withOwnership(() => renameSync(from, to)) })
        writeRestore('completed')
      } catch (error) {
        if (!error.recoveryRequired) {
          try { writeRestore('rolled-back') } catch (journalError) {
            error = Object.assign(new Error(`原版恢复结果需要检查：${journalFile}；${journalError.message}`, { cause: error }), { recoveryRequired: true, code: 'recovery-required' })
          }
        }
        throw error
      }
    }
    return await performInstallation(request, { ...options, ownership: lease, afterCopy: () => assertInstallationIdle(request) })
  } catch (error) {
    if (error.recoveryRequired) {
      try { lease.retain(error.message, { ownerDone: true }) } catch { /* Never alter a replacement owner. */ }
    }
    throw error
  } finally {
    // Unsafe transactions retain the install fence until explicit recovery.
    try { if (!lease.owner.unsafeToRetry) lease.release() } catch { /* A lost lease cannot release its replacement. */ }
  }
}

/** Run outside the profiles tree; never relaunch an app after failed recovery. */
export async function runSwitchJob(job, {
  wait = waitForExit, waitOwned = waitForOwnedExit, perform = performJob, cleanup = cleanupOwnedProcesses,
  relaunch = relaunchApp,
} = {}) {
  const lock = dirname(job)
  try { writeFileSync(join(lock, 'worker.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: 'wx', mode: 0o600 }) } catch {}
  let request
  let exited = false
  let recoveryRequired = false
  let failed = false
  let log = () => {}
  try {
    request = JSON.parse(readFileSync(job, 'utf8'))
    log = message => appendFileSync(join(request.stateDir, 'last-run.log'), new Date().toISOString() + ' ' + message + '\n')
    const persist = result => writeFileSync(join(request.stateDir, 'last-result.json'), JSON.stringify({
      mode: request.mode, stamp: request.stamp, finishedAt: new Date().toISOString(),
      logPath: join(request.stateDir, 'last-run.log'), ...result,
    }), { mode: 0o600 })
    log(`已排队 ${request.stamp} (${request.mode})，等待官方桌面正常退出。`)
    try {
      if (request.ownership) await waitOwned(request.ownership)
      else await wait(request.pids)
      exited = true
      if (['relocate', 'uninstall'].includes(request.mode) && request.ownership?.descendants?.length) {
        // Copying user data requires writers to be gone, not merely an unlocked
        // directory. Do not force-close tasks for an installation operation.
        await waitOwned({ roots: request.ownership.descendants }, { timeout: 15000 })
      }
      let cleaned = false
      const result = await perform(request, { retry: { onRetry: async ({ from, to, code, attempt }) => {
        log(`目录占用重试 ${attempt}: ${code} ${from} → ${to}`)
        if (!cleaned) {
          cleaned = true
          // Only identities captured while Desktop was still alive are eligible.
          // Unrelated sessions and unknown occupiers are never force-closed.
          if (request.ownership && !['relocate', 'uninstall'].includes(request.mode)) await cleanup(request.ownership, { log })
          else log('无可验证的桌面子进程记录；仅等待目录锁释放，不结束任何进程。')
        }
      } } })
      log(JSON.stringify(result))
      persist({ status: 'succeeded', message: '切换完成。' })
      log('切换完成。')
    } catch (error) {
      failed = true
      recoveryRequired = error.recoveryRequired === true
      log('ERROR: ' + error.message)
      persist({ status: 'failed', message: error.message, code: error.code, recoveryRequired })
    }
  } catch (error) {
    failed = true
    log('ERROR: ' + error.message)
  } finally {
    if (exited && !recoveryRequired && request?.relaunch) {
      try { relaunch(request.relaunch); log('已重新打开官方桌面。') } catch (error) { log('ERROR: 无法重新打开官方桌面：' + error.message) }
    }
    if (recoveryRequired) log('入口需要手动恢复，未重新打开桌面；请保留备份和日志。')
    try {
      rmSync(job, { force: true })
      rmSync(join(lock, 'worker.json'), { force: true })
      rmSync(join(lock, 'runtime'), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      rmdirSync(lock)
    } catch (error) { log('助手临时文件保留，操作结果不变：' + error.message) }
  }
  return failed ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runSwitchJob(process.argv[2])
}
