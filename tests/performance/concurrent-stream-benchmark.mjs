#!/usr/bin/env node
// 服务端并发流式基准（合成、离线、不碰用户存档）：同一事件循环上跑 N 路"假模型流"，量出每 chunk 的 CPU 与
// 事件循环延迟，判断"多开几个对话就卡"里服务端占多少。不动业务代码、不联网、不写用户数据。
//
//   node tests/performance/concurrent-stream-benchmark.mjs            # 默认 1/3/5 路，25 字/秒
//   node tests/performance/concurrent-stream-benchmark.mjs --sessions 1,3,5,8 --rate 25 --seconds 12
//   node tests/performance/concurrent-stream-benchmark.mjs --stage false --request-log 2mb
//
// 模拟的是服务端 per-chunk / per-request 的真实工作（见各段注释里的源码位置）：
//   model-stream.js:162-171   每个 chunk 的累加、blockTypes、progress
//   stage-director-stream.js:70-79   舞台"开演前"每 chunk 对全文重跑宏引擎+正则+stagePages
//   api-session-controller:1546      每个 chunk 序列化一帧推给 follower
//   model-request-log.js:62-63       每个请求把整份 context JSON.stringify 后落盘（异步、同循环）
//   worldbook-recall-log.js:70-72    每个请求拼接全部文本 + 每条 recall 做全文 includes
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const R = new URL('../../tavern-plugin/lib/domain/', import.meta.url).href
const { projectedSceneText } = await import(R + 'scene-illustration.js')
const { stagePages } = await import(R + 'stage-performance.js')

const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const at = argv.indexOf('--' + name)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const SESSIONS = String(option('sessions', '1,3,5')).split(',').map(Number).filter(n => n > 0)
const RATE = Number(option('rate', 25))            // 字/秒/路：中文正文的常见生成速度
const SECONDS = Number(option('seconds', 12))      // 每档跑多久
const STAGE = option('stage', 'true') !== 'false'  // 舞台模式开关
const REQUEST_LOG = option('request-log', '350kb') // 每请求的日志工作量：off | 350kb | 2mb
const RECALL_OUTPUTS = Number(option('recall-outputs', 8)) // 每次请求的 recall 条目数

const PROSE = '她抬起头，看着窗外的雨。屋檐下的水线拉成一条银亮的细线，风掠过，帘子轻轻一摆。他沉默了一会儿，才开口说话，声音很低。'
const DIALOGUE = '「别去了。」她说，「外面的路已经被水淹了。」'

function paragraph(i) {
  return '## 第 ' + i + ' 段\n\n' + PROSE + DIALOGUE + PROSE + '\n\n- 雨水顺着瓦槽流下\n- 灯火在窗后晃动\n\n'
}
// 每路流按"自然正文"生成：段落、台词、列表，够 stagePages 与 markdown 都吃满。
function nextChunk(state, chars) {
  while (state.buffer.length < chars) state.buffer += paragraph(++state.paragraph)
  const text = state.buffer.slice(0, chars)
  state.buffer = state.buffer.slice(chars)
  return text
}

const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]
const p95 = list => [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(list.length * 0.95))]

function fakeFrame(text, turn) {
  // api-session-controller 推送的 transient 帧：正文块 + 少量元数据
  return {
    type: 'transient', turn, step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    status: 'running'
  }
}

async function requestWork(root, size) {
  // model-request-log：整份 context 的 stringify + 落盘（异步，但 CPU 在同一条循环上）
  const parts = []
  let bytes = 0
  const block = PROSE + DIALOGUE
  while (bytes < size) { parts.push({ role: 'user', content: [{ type: 'text', text: block }] }); bytes += block.length }
  const context = { messages: parts, system: 'system prompt' }
  let t = performance.now()
  const body = JSON.stringify(context)
  const serializeMs = performance.now() - t
  const file = path.join(root, 'req-' + Math.random().toString(36).slice(2) + '.json')
  t = performance.now()
  const writing = writeFile(file, body)
  const dispatchMs = performance.now() - t
  await writing

  // worldbook-recall-log.requested：拼接全文 + 每条 recall 一次全文 includes
  const outputs = Array.from({ length: RECALL_OUTPUTS }, (_, i) => PROSE.slice(i, i + 40))
  t = performance.now()
  const requestText = context.messages.flatMap(m => m.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n')
  let hits = 0
  for (const output of outputs) if (requestText.includes(output.slice(0, 24))) hits++
  const recallMs = performance.now() - t
  await rm(file, { force: true })
  return { serializeMs, dispatchMs, bytes: body.length, recallMs, hits }
}

async function runCase(sessions, root) {
  const histogram = monitorEventLoopDelay({ resolution: 10 })
  histogram.enable()
  const states = Array.from({ length: sessions }, () => ({ buffer: '', paragraph: 0, started: false, turn: 1 }))
  const chunkChars = Math.max(1, Math.round(RATE / 25)) // 每 40ms 一个 chunk，按速率给字数
  const intervalMs = 40
  const totalChunks = Math.round((SECONDS * 1000) / intervalMs)
  const perChunk = []
  let frameBytes = 0, stageCost = 0, requestCost = 0, chunks = 0
  const stopAt = Date.now() + SECONDS * 1000
  let tick = 0

  const size = REQUEST_LOG === '2mb' ? 2 * 1024 * 1024 : 350 * 1024
  const request = REQUEST_LOG === 'off' ? null : await requestWork(root, size)
  const requestSamples = []
  if (request) requestSamples.push(request.serializeMs + request.recallMs)

  while (Date.now() < stopAt) {
    const at = performance.now()
    for (const state of states) {
      const text = nextChunk(state, chunkChars)
      // model-stream 钩子：O(1) 累加（真实实现是字符串拼接 + Map.set）
      state.raw = (state.raw || '') + text
      // 舞台：started 之前每 chunk 全文重算（stage-director-stream.js:70-79）
      if (STAGE && !state.started) {
        const complete = state.raw.slice(0, state.raw.lastIndexOf('\n') + 1)
        if (complete !== '' && !/\{\{|<%|<(script|style)\b/i.test(complete) && complete.lastIndexOf('<') <= complete.lastIndexOf('>')) {
          const s = performance.now()
          const pages = stagePages(projectedSceneText(complete))
          stageCost += performance.now() - s
          if (pages.length >= 5) { state.started = true; state.pages = pages.slice(0, 5) }
        }
      }
      // 推帧：每个 chunk 序列化一次并推给 follower
      const frame = JSON.stringify(fakeFrame(state.raw, state.turn))
      frameBytes = frame.length
      chunks++
    }
    perChunk.push(performance.now() - at)
    tick++
    if (tick % 25 === 0 && request) {
      const sample = await requestWork(root, size)
      requestSamples.push(sample.serializeMs + sample.recallMs)
    }
    const wait = intervalMs - (performance.now() - at)
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
  }
  histogram.disable()
  const chunkMs = median(perChunk)
  const budget = 1000 / intervalMs
  if (requestSamples.length) requestCost = median(requestSamples)
  return {
    会话数: sessions,
    '每chunk CPU ms(中位)': +chunkMs.toFixed(2),
    '每chunk CPU ms(p95)': +p95(perChunk).toFixed(2),
    '单核占用%(含N路)': +((chunkMs * sessions) / intervalMs * 100).toFixed(1),
    '事件循环延迟 p99 ms': +(histogram.percentile(99) / 1e6).toFixed(2),
    '事件循环延迟 max ms': +(histogram.max / 1e6).toFixed(2),
    '舞台累计 CPU ms': +stageCost.toFixed(0),
    '请求日志 CPU ms/次': +requestCost.toFixed(2),
    '帧字节': frameBytes,
    'chunk 数': chunks,
    预算: budget
  }
}

const root = await mkdtemp(path.join(os.tmpdir(), 'tavern-stream-bench-'))
const rows = []
try {
  for (const sessions of SESSIONS) rows.push(await runCase(sessions, root))
} finally {
  await rm(root, { recursive: true, force: true })
}
console.log('平台', process.platform, process.arch, process.version,
  '| 速率', RATE + ' 字/秒/路 | 舞台', STAGE ? '开' : '关', '| 请求日志', REQUEST_LOG, '| recall 条目', RECALL_OUTPUTS)
console.table(rows)
console.log('说明：本机是桌面 CPU。手机单核/小核按 3~10 倍乘；“单核占用%”≥100 表示该档已经排满一颗核，浏览器渲染只能抢剩下的时间片。')
