// 生产路径由后台管理器持有编辑期所有权；兼容没有管理器的独立领域调用。
export async function withBackgroundSession(sessions, sessionId, parentSessionId, work) {
  if (typeof sessions.withBackground === 'function') return sessions.withBackground(sessionId, parentSessionId, work)
  let handle
  try {
    let worker = sessions.get(sessionId)
    let session = worker?.session || sessions.getSession?.(sessionId)
    if (!session && typeof sessions.resume === 'function') {
      handle = await sessions.resume(sessionId)
      worker = handle.agent
      session = worker?.session
    }
    if (!session) throw new Error('后台会话尚未加载，将在下次后台任务启动时重试')
    return await work(session, worker)
  } finally {
    if (handle) await handle.dispose()
  }
}
