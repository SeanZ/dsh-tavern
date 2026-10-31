import test from 'node:test'
import assert from 'node:assert/strict'
import { imagePluginFixture } from './fixtures/image-plugin-runtime.mjs'

const definitions = { characters: [{
  id: 'person-1', name: '柳如是', match: 'Liu Rushi', enabled: true,
  traits: { face: '她是一位二十岁的年轻女子，鹅蛋脸', bodySFW: '身形纤细' },
  outfits: [{ id: 'old', name: '制服（冬季）', upper: 'wool coat', lower: 'long skirt', enabled: true }],
}] }

test('临时运行时保存并重载设计设置，三种语言模式进入角色与服装真实模型请求', async t => {
  const calls = []
  let outfitNumber = 0
  const llm = {
    async *stream(input) {
      calls.push(structuredClone(input))
      const system = String(input.system ?? '')
      const text = system.includes('你是角色服装设计师')
        ? '[{"name":"制服（夏季 ' + (++outfitNumber) + '）","upper":"summer blouse","lower":"pleated skirt","shoes":"white stockings"}]'
        : ''
      yield { type: 'text-delta', text }
    },
  }
  const fixture = await imagePluginFixture(t, {
    config: { allowChinesePrompt: true }, definitions, llm,
  })
  let runtime = await fixture.start()
  const initialState = await runtime.request('state')
  assert.equal(initialState.body.config.closestMountTolerance, false, '挂载容错默认关闭')

  const modes = [
    { value: 'auto', language: '中文整句' },
    { value: 'chinese', language: '中文整句' },
    { value: 'tags', language: '英文 Tag' },
  ]
  for (const mode of modes) {
    const saved = await runtime.request('config', { config: {
      designPromptMode: mode.value,
      closestMountTolerance: true,
      characterDesignRequirements: '角色要求测试：保留银色瞳孔',
      outfitDesignRequirements: '服装要求测试：采用可拆卸披肩',
    } })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))

    const before = calls.length
    const design = await runtime.request('design', { useCard: false, brief: '生成一个虚构角色' })
    assert.equal(design.status, 200, JSON.stringify(design.body))
    const roleRequest = calls[before]
    assert.match(roleRequest.system, new RegExp('生成语言：' + mode.language))
    assert.match(roleRequest.system, /角色要求测试：保留银色瞳孔/)
    assert.match(roleRequest.system, /服装要求测试：采用可拆卸披肩/)
    assert.ok(roleRequest.system.indexOf('角色要求测试') < roleRequest.system.indexOf('生成语言：'), '用户要求后由所选语言约束收尾')

    const outfitBefore = calls.length
    const generated = await runtime.request('generate-outfits', { characterId: 'person-1', count: 1 })
    assert.equal(generated.status, 200, JSON.stringify(generated.body))
    const outfitRequest = calls[outfitBefore]
    assert.match(outfitRequest.system, /服装要求测试：采用可拆卸披肩/)
    assert.match(outfitRequest.system, mode.language === '英文 Tag' ? /写法选择】使用英文绘图 Tag/ : /写法选择】使用中文整句/)
    assert.ok(outfitRequest.system.indexOf('服装要求测试') > outfitRequest.system.indexOf('不写开衩'), '用户风格要求位于默认服装建议之后')
    const outfitNames = (await fixture.read('definitions.json')).characters[0].outfits.map(item => item.name)
    assert.equal(outfitNames[0], '制服（冬季）')
    assert.ok(outfitNames.includes('制服（夏季 ' + outfitNumber + '）'))
  }

  runtime.close()
  runtime = await fixture.start()
  const reloaded = await runtime.request('state')
  assert.equal(reloaded.body.config.designPromptMode, 'tags')
  assert.equal(reloaded.body.config.closestMountTolerance, true)
  assert.equal(reloaded.body.config.characterDesignRequirements, '角色要求测试：保留银色瞳孔')
  assert.equal(reloaded.body.config.outfitDesignRequirements, '服装要求测试：采用可拆卸披肩')
})
