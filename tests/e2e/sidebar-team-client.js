// 隔离浏览器验收只通过宿主公开服务选择会话和打开Tasks。
window.__ModuleLoader__.load({
  id: 'sidebar-team-e2e',
  factory() {
    return {
      name: 'sidebar-team-e2e', inject: ['uiWorkspace', 'betterSidebar', 'sessions'],
      apply(ctx) {
        if (location.hostname !== '127.0.0.1') throw new Error('验收客户端仅允许本地回环地址')
        window.sidebarTeamFixture = {
          open: id => ctx.uiWorkspace.openSession(id),
          tasks: () => ctx.betterSidebar.openTab({ type: 'subagent', title: 'Tasks' }),
          snapshot: () => ctx.sessions.list.getSnapshot(),
        }
        ctx.effect(() => () => { delete window.sidebarTeamFixture })
      },
    }
  },
})
