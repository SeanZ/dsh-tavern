import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// 真实插件 RPC + 真实宿主 Session 跑一遍完整场景（fixtures/floor-fork-rpc.mjs），每条边界一个子测试。
let run
async function scenario() {
  if (run) return run
  const root = await mkdtemp(join(tmpdir(), 'tavern-floor-fork-'))
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/floor-fork-rpc.mjs', import.meta.url))], {
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
  assert.match(output, /floor fork rpc passed/)
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
test('(6) 开场楼层可分叉', realHost, () => passed('6 开场楼层可分叉'))
test('(8) 原会话零改动：事件、存档历史与快照目录', realHost, () => passed('8 原会话零改动'))
test('(9) 楼层快照按楼层复制到新局', realHost, () => passed('9 快照按楼层复制'))
test('(10) forkTurnsByMessageId 在切换后仍指向正确故事轮（新流程不依赖它）', realHost, () => passed('10 forkTurnsByMessageId 切换后仍指向故事轮'))
test('(11) MVU 卡切换结果后存档标记变量未重算，分叉新局带着标记', realHost, () => passed('11 MVU 变量未重算标记随存档与分叉保留'))
test('新局再折叠楼层与 history[].current 正确，下一轮请求里是选中版本', realHost, () => passed('C1 新局折叠与下一轮请求是选中版本'))

test('删除分支通过真实 RPC 回收快照，源局快照保持', realHost, () => passed('12 删除分支回收快照且源局不变'))
