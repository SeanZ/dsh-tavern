import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// 真实插件 RPC + 真实宿主 Session 跑一遍从楼层创建分支的完整场景（fixtures/story-fork-rpc.mjs），
// 走独立 UI 的现役路径（prepareConversationFork / forkChat 的消息身份模式），每条边界一个子测试。
let run
async function scenario() {
  if (run) return run
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tavern-story-fork-')))
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/story-fork-rpc.mjs', import.meta.url))], {
      env: { ...process.env, DSH_HOME: root }, encoding: 'utf8', timeout: 60000
    })
    assert.ifError(result.error)
    run = { status: result.status, output: result.stdout + result.stderr }
  } finally { await rm(root, { recursive: true, force: true }) }
  return run
}
const realHost = { skip: !process.env.DSH_BOOT_MODULE && '需要 DSH_BOOT_MODULE 指向真实宿主', timeout: 90000 }
async function passed(name) {
  const { output } = await scenario()
  assert.ok(output.split('\n').includes('ok ' + name), output)
}

test('整场：全部检查通过', realHost, async () => {
  const { status, output } = await scenario()
  assert.equal(status, 0, output)
  assert.match(output, /story fork rpc passed/)
})
test('(1) 切换历史结果后分叉：非最新层与最新层都带走选中版本', realHost, async () => {
  await passed('1 切换结果后分叉带走选中版本')
  await passed('1b 最新楼层切换结果后分叉')
})
test('(2) 重新生成落定后分叉带走落定版本', realHost, () => passed('2 重生成落定后分叉带走落定版本'))
test('(3) 非最新楼层：不带后续楼层、输入与 MVU 变化，变量回到该层', realHost, () => passed('3 非最新楼层不带后续楼层、输入与 MVU 变化'))
test('(4) 撤回、打断墓碑与失败尾部不带过去也不拒绝', realHost, () => passed('4 撤回、打断与失败尾部不带过去也不拒绝'))
test('(5) 运行中、重新生成尝试中、后台结算中拒绝，源局不变', realHost, async () => {
  await passed('5a 运行中拒绝')
  await passed('5b 重生成尝试中拒绝')
  await passed('5c 后台结算中拒绝')
})
test('(5d) 失效 UID、revision 冲突、非正文消息与目标会话校验拒绝，源局不变', realHost, () => passed('5d 冲突、失效身份与目标校验拒绝'))
test('(6) 开场楼层可分叉', realHost, () => passed('6 开场楼层可分叉'))
test('(8) 原会话零改动：事件、存档历史与快照目录', realHost, () => passed('8 原会话零改动'))
test('(9) 新局快照身份独立：不串用源局，可写读当前渲染版本', realHost, () => passed('9 新局快照身份独立且可写读当前版本'))
test('(10) forkTurnsByMessageId 在切换后仍指向正确故事轮（新流程不依赖它）', realHost, () => passed('10 forkTurnsByMessageId 切换后仍指向故事轮'))
test('(11) MVU 卡切换结果后存档标记变量未重算，分叉新局带着标记', realHost, () => passed('11 MVU 变量未重算标记随存档与分叉保留'))
test('新局再折叠楼层只含选中版本，下一轮请求里是选中版本', realHost, () => passed('C1 新局折叠与下一轮请求是选中版本'))

test('删除分支通过真实 RPC 回收快照，源局与其它分支快照保持', realHost, () => passed('12 删除分支回收快照且源局不变'))

test('部分正文的历史切换和分叉保留不完整状态及变量边界', realHost, () => passed('13 部分正文结果切换与分叉保留不完整状态及变量边界'))

test('压缩后早期楼层分叉且源局上下文不变', realHost, () => passed('14 压缩后早期楼层分叉且源局上下文不变'))

test('(15) 原生上下文建立失败后标记 stale、核对明确报告，开场恢复明确拒绝且不重复开场', realHost, () => passed('15 原生上下文建立失败后标记 stale、核对报告且不重复开场'))

test('(16) 存档救援导入的消息拒绝分叉', realHost, () => passed('16 救援导入的消息拒绝分叉'))
