// 皮肤的文字出现方式 (cast-presentation.md 27/N) on the real stage: a skin's textFx draws how its glyphs come in. A stepped reveal
// (pop) shows the line in steps on one 12/s clock, each new glyph in its entry pose and then its landing pose before it joins
// the plain text; the skin's own poses (with emphasis jitter) replace the reveal's two; the system's reduced motion keeps the
// steps without poses; a click finishes the line as plain text; 经典 (type) still fades glyph by glyph. Fresh disposable profile
// only, no model calls. Nothing reaches a speaker: every AudioContext ends in stage-state's zero gain.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { stageNext, stageStateChecks } from './stage-state.mjs'

const endpoint = process.env.TAVERN_STAGE_TEST_CDP
const output = process.argv[process.argv.indexOf('--artifacts') + 1]
if (!process.argv.includes('--isolated') || !endpoint || new URL(endpoint).port === '9333' || !process.argv.includes('--artifacts')) throw Error('Requires an owned fresh-profile CDP, --isolated and --artifacts DIR; never use a live browser')

const LINE = '走廊在傍晚的光里一直延伸下去，长而安静，沿途的每一扇窗都映着同一片橘色的天空。她走得很慢，像是在数自己的脚步。'
const body = ['"Ready."', LINE, 'She stops.'].join('\n')
// Two original skins: ink on paper that pops its glyphs in, and the same paper stamping them with its own three poses.
const paper = { textbox: { paint: { bg: '#f4efe6', fg: '#1d1a22', fgMuted: '#4a4550', accent: '#8a2a3a', onAccent: '#ffffff', border: '#4a4550' }, shape: { radius: 4 } },
  nameplate: { shape: 'plain', paint: { bg: '#2a2440', fg: '#ffffff' } }, font: {} }
const pop = { schema: 'dsh.skin/1', id: 'paper-pop', label: '纸·跳', ...paper, textFx: { reveal: 'pop', stepFps: 12, charsPerStep: 2, flash: '#8a2a3a' } }
const stamp = { schema: 'dsh.skin/1', id: 'paper-stamp', label: '纸·印', ...paper,
  textFx: { reveal: 'stamp', stepFps: 6, from: 'bottom', flash: '#8a2a3a', emphasis: 'jitter', jitter: 1.5, poses: [{ dy: .4, scale: 1.4, ink: 'flash' }, { dy: -.1, rot: -6, ink: 'accent' }, { scale: 1.06 }] } }

await mkdir(output, { recursive: true })
const browser = await chromium.connectOverCDP(endpoint)
try {
  const pages = browser.contexts().flatMap(context => context.pages()).filter(page => /^(https?:|dsh-app:)/.test(page.url()))
  assert.equal(pages.length, 1)
  const page = pages[0]
  page.setDefaultTimeout(20000)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.evaluate(() => localStorage.removeItem('dsh-tavern-stage-reading'))
  try {
    const result = await stageStateChecks({ page, output, bodyText: body,
      async inspect({ stage, call, cardPath }) {
        const steps = {}
        const progress = stage.locator('.dsh-tavern-stage-progress')
        const at = value => progress.filter({ hasText: value }).waitFor()
        const backButton = stage.getByRole('button', { name: '上一句', exact: true })
        const overlay = page.locator('.dsh-tavern-stage-overlay')
        // 经典 first: the plain typewriter, no stepped paint.
        await at('1 / 3'); await stageNext(stage); await at('2 / 3')
        await page.waitForTimeout(200)
        assert.equal(await stage.locator('.dsh-tavern-stage-type[data-skin-reveal]').count(), 0, '经典 types plainly')
        assert.ok(await stage.locator('.dsh-tavern-stage-glyph').count() > 0, 'glyph by glyph')
        // The skins enter as a pack's entries (添加文件 › 皮肤 takes the same upload); the pack is the card's, its default the skin.
        const upload = document => page.evaluate(async text => (await (await fetch('/api/dsh-tavern/card-upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: text })).json()).uploadId, JSON.stringify(document))
        const { pack } = await call('createAssetPack', { name: '纸 ' + Date.now() % 100000 })
        for (const skin of [pop, stamp]) await call('addAssetPackSkin', { packId: pack.manifest.id, document: await upload(skin), files: [] })
        const useSkin = async id => {
          const revision = (await call('getAssetPack', { packId: pack.manifest.id })).pack.revision
          await call('setAssetPackStageSkin', { packId: pack.manifest.id, expectedRevision: revision, skin: id })
          await page.evaluate(() => window.dispatchEvent(new CustomEvent('dsh-tavern-settings-changed')))
          await page.locator('.dsh-tavern-stage-overlay[data-fk-skin="' + id + '"]').waitFor()
        }
        await call('setAssetPackState', { path: cardPath, packId: pack.manifest.id, state: 'card' })
        await useSkin('paper-pop')
        // Watches the line from the page: every change of what shows (the posed glyphs' ages, how many glyphs show) with its time.
        const watch = () => page.evaluate(() => {
          window.hopLog = []
          const note = () => {
            const type = document.querySelector('.dsh-tavern-stage-text .dsh-tavern-stage-type')
            if (!type) return
            const paints = [...type.querySelectorAll('.dsh-tavern-stage-glyph-paint')]
            const visible = (type.querySelector('.dsh-tavern-stage-type-shown')?.textContent.length || 0) + type.querySelectorAll('.dsh-tavern-stage-glyph').length
            const entry = { at: performance.now(), visible, hops: paints.map(p => p.dataset.hop).join(''), reveal: type.dataset.skinReveal || '', typed: type.hasAttribute('data-typed') }
            const last = window.hopLog.at(-1)
            if (!last || last.visible !== entry.visible || last.hops !== entry.hops || last.reveal !== entry.reveal) window.hopLog.push(entry)
          }
          window.hopObserver?.disconnect()
          window.hopObserver = new MutationObserver(note)
          window.hopObserver.observe(document.querySelector('.dsh-tavern-stage-overlay'), { subtree: true, childList: true, attributes: true, characterData: true })
          note()
        })
        // The posed copies' painted transforms right now.
        const poses = () => stage.evaluate(node => [...node.querySelectorAll('.dsh-tavern-stage-glyph-paint')].map(p => ({ hop: p.dataset.hop, transform: getComputedStyle(p, '::after').transform, color: getComputedStyle(p, '::after').color })))
        const replay = async () => { await backButton.click(); await at('1 / 3'); await watch(); await stageNext(stage); await at('2 / 3') }
        // 1. pop: in steps on the 12/s grid, each new glyph posed (entry, then landing) before it joins the plain run.
        await replay()
        await page.waitForTimeout(500)
        const mid = await poses()
        assert.ok(mid.length > 0 && mid.every(p => ['0', '1'].includes(p.hop)), 'posed glyphs: ' + JSON.stringify(mid))
        assert.ok(mid.some(p => p.transform !== 'none'), 'a pose is drawn: ' + JSON.stringify(mid))
        await page.screenshot({ path: join(output, 'w1920-pop-typing.png') })
        await stage.locator('.dsh-tavern-stage-type[data-typed]').waitFor()
        await page.waitForTimeout(400)
        const run = await page.evaluate(() => window.hopLog)
        const stepped = run.filter(entry => entry.reveal === 'pop')
        assert.ok(stepped.length >= 10, 'stepped changes: ' + stepped.length)
        const gaps = stepped.slice(1).map((entry, i) => entry.at - stepped[i].at)
        assert.ok(gaps.filter(gap => gap > 20).every(gap => Math.abs(gap / (1000 / 12) - Math.round(gap / (1000 / 12))) < .35), 'changes land on the 12/s steps: ' + JSON.stringify(gaps.map(Math.round)))
        const counts = [...new Set(stepped.map(entry => entry.visible))]
        assert.ok(counts.slice(1).every((count, i) => count - counts[i] >= 2 || count === Array.from(LINE).length), 'glyphs come in the skin\'s pairs: ' + JSON.stringify(counts))
        assert.equal(await stage.locator('.dsh-tavern-stage-glyph-paint').count(), 0, 'landed: the line is plain text')
        assert.equal(await stage.locator('.dsh-tavern-stage-text .dsh-tavern-stage-type').innerText(), LINE)
        steps.pop = { changes: stepped.length, medianGap: Math.round(gaps.sort((a, b) => a - b)[gaps.length >> 1]), first: counts.slice(0, 6) }
        // 2. A click finishes it at once: plain text, no posed copies.
        await replay(); await page.waitForTimeout(300)
        await stage.locator('.dsh-tavern-stage-scene').click({ position: { x: 300, y: 200 } })
        await stage.locator('.dsh-tavern-stage-type[data-typed]').waitFor()
        assert.equal(await stage.locator('.dsh-tavern-stage-type[data-skin-reveal]').count(), 0, 'finished: plain text')
        assert.equal((await progress.innerText()).trim(), '2 / 3', 'the click finished the line, it did not turn the page')
        steps.finish = true
        // 3. The skin's own three poses with emphasis jitter (stamp from below, two steps a pose at stepFps 6).
        await useSkin('paper-stamp')
        await replay(); await page.waitForTimeout(600)
        const own = await poses()
        assert.ok(own.some(p => p.hop === '0') && own.every(p => ['0', '1', '2'].includes(p.hop)), 'the skin\'s three poses: ' + JSON.stringify(own.map(p => p.hop)))
        const entry = own.find(p => p.hop === '0')
        assert.ok(entry && entry.transform !== 'none' && entry.color === 'rgb(138, 42, 58)', 'the entry pose in the flash ink: ' + JSON.stringify(entry))
        assert.equal(await stage.locator('.dsh-tavern-stage-type').getAttribute('data-skin-poses'), '3')
        assert.ok(await stage.locator('.dsh-tavern-stage-glyph-paint[style*="--gj-x"]').count() > 0, 'jitter offsets')
        await page.screenshot({ path: join(output, 'w1920-stamp-typing.png') })
        await stage.locator('.dsh-tavern-stage-type[data-typed]').waitFor()
        await page.waitForTimeout(700)
        assert.equal(await stage.locator('.dsh-tavern-stage-glyph-paint').count(), 0)
        steps.poses = own.map(p => p.hop).join('')
        // 4. The system's reduced motion: still in steps, without poses.
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await replay(); await page.waitForTimeout(500)
        const calm = await poses()
        assert.ok(calm.length > 0 && calm.every(p => p.transform === 'none'), 'steps without poses: ' + JSON.stringify(calm))
        await page.emulateMedia({ reducedMotion: 'no-preference' })
        await stage.locator('.dsh-tavern-stage-type[data-typed]').waitFor()
        steps.reducedMotion = calm.length
        // 5. A phone: the same steps inside the box.
        await page.setViewportSize({ width: 375, height: 812 })
        await useSkin('paper-pop')
        await replay(); await page.waitForTimeout(450)
        assert.ok((await poses()).length > 0)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
        await page.screenshot({ path: join(output, 'w375-pop-typing.png') })
        await stage.locator('.dsh-tavern-stage-type[data-typed]').waitFor()
        await page.waitForTimeout(400)
        await page.screenshot({ path: join(output, 'w375-pop-typed.png') })
        await page.setViewportSize({ width: 1920, height: 1080 })
        steps.phone = true
        return steps
      }
    })
    await writeFile(join(output, 'stage-text-fx.json'), JSON.stringify(result.performance, null, 2))
    console.log(JSON.stringify({ textFx: true, steps: result.performance, output }))
  } catch (error) {
    await writeFile(join(output, 'failure.txt'), error.stack + '\n' + await page.locator('body').innerText())
    await page.screenshot({ path: join(output, 'failure.png') })
    throw error
  }
} finally { await browser.close() }
