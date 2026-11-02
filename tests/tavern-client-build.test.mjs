import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from './fixtures/client-vm.mjs'

import { assembleTavernClient } from "../bin/build-tavern-client.mjs";

test('完整客户端必须可解析，局部源码测试不能代替入口语法检查', async () => {
  const source = await assembleTavernClient()
  assert.doesNotThrow(() => new vm.Script(source, { filename: 'tavern-plugin/lib/client.js' }))
  const shipped = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
  assert.equal(shipped, source, 'committed core client must match current sources; run node bin/build-tavern-client.mjs')
  assert.equal(source.includes('function createStageNavigation('), false, 'navigation implementation belongs to the optional client')
  // These moved features must stay in the optional payload, even when a future include is edited.
  const stage = await readFile(new URL('../tavern-plugin/packages/dsh-tavern-stage/lib/client.js', import.meta.url), 'utf8')
  for (const name of ['GalStage', 'createStageController', 'createStageSourceWidgets', 'stageWidgetStageGeometry', 'stageWidgetThread', 'phoneModSettingsView', 'createStageModSurface', 'createModUiLayerHost', 'createModStageDock', 'itemShowcasePlace', 'createStagePerformanceSurface', 'createStageSessions', 'createStageTextIndexModule', 'createStageInput', 'createStagePlayback', 'createStageSpeech', 'createStageRuntimeUi', 'createStageSessionObservation', 'createStageScene', 'galCreateScene', 'createStageSceneMath', 'createStageRuntimeKernel', 'createStageDisplayConsumers', 'createStageDisplays', 'createStageModNotifications', 'createStageResourceRunnerModule', 'createStageDirectorModule', 'createStageSessionRuntime', 'createStageRuntimeStoreModule', 'createStageSessionModule', 'createStageFigurePose', 'createStageCastLayout', 'createStageCast', 'createStageFigureAppearance', 'createStageFigureAssets', 'createStageFigureBlink', 'createBlinkScheduler', 'blinkPlacement', 'createStageCallViews', 'createStageBust', 'galBustFrame', 'galBustEnter', 'createStageMonologue', 'createStageBackgrounds', 'createStageBackgroundLayers', 'createStageSceneCamera', 'galShotTarget', 'galCameraClamp', 'createStageSceneTextures', 'createStageSpineFigures', 'createStageSceneGraphics', 'galFilterChain', 'galUseFilter', 'galMakeTextures', 'createStageEntrancePresentation', 'StageEntrance', 'createStageEntranceMedia', 'createStageEntranceRenderer', 'entranceRenderer', 'entrancePlateFrames', 'entranceLoop', 'createStageSkinPresentation', 'createStageSkinResources', 'createStageSkinAdapter', 'createStageSkinMotion', 'createStageSkinBacklog', 'createStageEffects', 'galCreateEffects', 'createStageLookUi', 'createStageLooks', 'createStageLookShaders', 'createStageLookArt', 'galCreateLookRenderer', 'createStageWeather', 'createStageEmotes', 'createStageEffectColors', 'galParticleArt', 'galEmoteArt', 'createStageFigureIdle', 'createStageFigureTap', 'createStageFigureWarp', 'createStageFigureMotion', 'galInstallMotionLayers', 'createStageDanmaku', 'createStageDanmakuScheduler', 'createStageDanmakuSession', 'createStageDanmakuAvatar', 'createLiveroomDashboard', 'createStageWidgets', 'createStagePhoneAdjust', 'createStagePhoneLayout', 'createStageGallery', 'createStageCg', 'createStageDevice', 'createStageMixer', 'createStageSfx', 'createStageTransitions', 'WidgetPanel', 'WidgetContextMenu', 'CgGalleryImage']) {
    const declaration = new RegExp('function\\s+' + name + '\\s*\\(')
    assert.equal(declaration.test(source), false, name + ' must not ship in the core payload')
    assert.equal(declaration.test(stage), true, name + ' must ship in the optional stage payload')
  }
  assert.equal(source.includes('.fork-tc-layer {'), false, 'stage text-card CSS is not embedded in core')
  assert.equal(source.includes('.fork-widget-source-controls{position:absolute;'), false, 'stage widget layout CSS is not embedded in core')
})

for (const check of [false, true]) {
  test(`客户端 ${check ? '--check' : 'build'} 拒绝非法语法且保留现有产物`, async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'tavern-client-build-')))
    t.after(() => rm(root, { recursive: true, force: true }))
    const builder = path.join(root, 'bin/build-tavern-client.mjs')
    const template = path.join(root, 'tavern-plugin/src/client/main.js')
    const output = path.join(root, 'tavern-plugin/lib/client.js')
    for (const directory of ['bin/lib', 'tavern-plugin/src/client', 'tavern-plugin/lib/client-assets']) {
      await mkdir(path.join(root, directory), { recursive: true })
    }
    await copyFile(new URL('../bin/build-tavern-client.mjs', import.meta.url), builder)
    await copyFile(new URL('../bin/build-interface-skin-client.mjs', import.meta.url), path.join(root, 'bin/build-interface-skin-client.mjs'))
    const skin = path.join(root, 'tavern-plugin/packages/dsh-dream-skin')
    await cp(new URL('../tavern-plugin/packages/dsh-dream-skin/src/', import.meta.url), path.join(skin, 'src'), {recursive:true})
    await mkdir(path.join(skin, 'lib'), {recursive:true})
    await copyFile(new URL('../tavern-plugin/packages/dsh-dream-skin/lib/client.js', import.meta.url), path.join(skin, 'lib/client.js'))
    const stage = path.join(root, 'tavern-plugin/packages/dsh-tavern-stage/lib/client')
    await mkdir(stage, {recursive:true})
    await copyFile(new URL('../tavern-plugin/packages/dsh-tavern-stage/lib/client/skin-overlay-timing.cjs', import.meta.url), path.join(stage, 'skin-overlay-timing.cjs'))
    await copyFile(new URL('../tavern-plugin/packages/dsh-tavern-stage/lib/client/timer-clock.cjs', import.meta.url), path.join(stage, 'timer-clock.cjs'))
    for(const name of ['lifetime.cjs','runtime-store.cjs','session.cjs','director-source.cjs','resource-runner.cjs','runtime-kernel.cjs'])await copyFile(new URL('../tavern-plugin/packages/dsh-tavern-stage/lib/client/'+name,import.meta.url),path.join(stage,name))
    await copyFile(new URL('../tavern-plugin/packages/dsh-tavern-stage/build.mjs', import.meta.url), path.join(stage, '../../build.mjs'))
    await cp(new URL('../tavern-plugin/packages/dsh-tavern-stage/src/', import.meta.url), path.join(stage, '../../src'), {recursive:true})
    await copyFile(new URL('../tavern-plugin/packages/dsh-tavern-stage/lib/client/runtime-kernel.cjs', import.meta.url), path.join(stage, 'runtime-kernel.cjs'))
    await copyFile(new URL('../bin/lib/client-export-guard.mjs', import.meta.url), path.join(root, 'bin/lib/client-export-guard.mjs'))
    await copyFile(new URL('../bin/lib/css-syntax-guard.mjs', import.meta.url), path.join(root, 'bin/lib/css-syntax-guard.mjs'))
    // The fixture includes every required inert builder input.
    for (const name of ['surfaces.cjs']) {
      await copyFile(new URL('../tavern-plugin/src/client/' + name, import.meta.url), path.join(root, 'tavern-plugin/src/client', name))
    }
    for (const name of ['tavern.css', 'theme.css', 'layered-sprite.css', 'mod-config.css']) await writeFile(path.join(root, 'tavern-plugin/lib/client-assets', name), '')
    await mkdir(path.join(root, 'tavern-plugin/shared'), { recursive: true })
    await writeFile(path.join(root, 'tavern-plugin/shared/keyword-catalogue.cjs'), 'module.exports = {};')
    // The copied builder imports its dependencies (acorn) by package name. Windows needs a privilege to make
    // symlinks; there the test runner's resolve hook finds the packages instead.
    if (process.platform !== 'win32') await symlink(new URL('../node_modules', import.meta.url).pathname, path.join(root, 'node_modules'), 'dir')
    for (const name of ['logo', 'lockup', 'lockup-dark']) await writeFile(path.join(root, `tavern-plugin/lib/client-assets/${name}.svg`), '<svg/>')
    const valid = '// @include-stage runtime-kernel.cjs\nconst fixture = 1;\n'
    const invalid = 'const = 1;\n'
    await writeFile(template, valid)
    const build = args => spawnSync(process.execPath, [builder, ...args], { encoding: 'utf8', timeout: 10000 })
    const initial = build([])
    assert.ifError(initial.error)
    assert.equal(initial.status, 0, initial.stderr)
    let previous = await readFile(output, 'utf8')
    assert.ok(previous.includes('function createStageRuntimeKernel('))
    assert.ok(previous.includes('const fixture = 1;'))
    await writeFile(template, invalid)
    if (check) {
      // Keep source and output in sync so an outdated-output error cannot pass this test.
      previous = previous.replace('const fixture = 1;', invalid)
      await writeFile(output, previous)
    }
    const result = build(check ? ["--check"] : []);
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Unexpected token/);
    assert.equal(await readFile(output, "utf8"), previous);
  });
}

test('故事领域与前端适配器独立装配，拒绝越界读取并保留原产物', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'tavern-story-include-')))
  t.after(() => rm(root, {recursive:true,force:true}))
  for (const directory of ['bin', 'tavern-plugin/src/client/story','tavern-plugin/lib/story']) await mkdir(path.join(root,directory),{recursive:true})
  for (const name of ['node_modules','bin/lib','tavern-plugin/packages','tavern-plugin/shared','tavern-plugin/lib/client-assets','tavern-plugin/src/client/surfaces.cjs']) {
    await symlink(new URL('../'+name,import.meta.url),path.join(root,name))
  }
  for (const name of ['build-tavern-client.mjs','build-interface-skin-client.mjs']) await copyFile(new URL('../bin/'+name,import.meta.url),path.join(root,'bin',name))
  await writeFile(path.join(root,'tavern-plugin/lib/story/rounds.js'),'function fold() { return 42; }\nexport { fold };\n')
  await writeFile(path.join(root,'tavern-plugin/src/client/story/adapter.js'),'function adapter(value) { return value; }\nexport { adapter };\n')
  const template=path.join(root,'tavern-plugin/src/client/main.js'), output=path.join(root,'tavern-plugin/lib/client.js')
  await writeFile(template,'// @include-story rounds.js\n// @include-story-client adapter.js\nif (adapter(fold()) !== 42) throw new Error("story include missing");\n')
  const build=()=>spawnSync(process.execPath,['--input-type=module','-e',
    'import {assembleTavernClient} from "./bin/build-tavern-client.mjs"; import {writeFile} from "node:fs/promises"; await writeFile("tavern-plugin/lib/client.js", await assembleTavernClient())'],{cwd:root,encoding:'utf8',timeout:10000})
  const accepted=build();assert.equal(accepted.status,0,accepted.stderr)
  const previous=await readFile(output,'utf8');assert.doesNotThrow(()=>new vm.Script(previous).runInNewContext())
  for(const kind of ['story','story-client']) {
    await writeFile(template,'// @include-'+kind+' ../private.js\n')
    const refused=build();assert.equal(refused.status,1);assert.match(refused.stderr,/include 越界/)
    assert.equal(await readFile(output,'utf8'),previous,'拒绝后保留原产物')
  }
})
