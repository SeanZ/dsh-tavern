// 新宿主返回带身份和生命周期的 Peer。酒馆的全局操作只接受仍有效的 owner。
export function tavernRequestRejection(connection, request, peer) {
  if (peer) return peer.signal && !peer.signal.aborted && peer.principal?.kind === 'owner' ? undefined : 403
  if (typeof connection?.requestRejection === 'function') return connection.requestRejection(request)
  if (typeof connection?.admit === 'function') {
    const result = connection.admit(request)
    if (result?.rejection) return result.rejection
    if (!result?.peer?.signal || result.peer.signal.aborted) return 401
    return result.peer.principal?.kind === 'owner' ? undefined : 403
  }
  return 503
}
