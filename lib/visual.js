/**
 * `visual`：一次调用同时返回「文本稿 + 画面」。
 *
 * 为什么单独一层：CLI 只能把图片写到磁盘、把路径打到 stdout；要把图片**作为工具结果的一部分**
 * 交给多模态模型，必须由宿主把文件变成 DSH 的附件（`attachments.saveImage`）再塞进
 * 工具的 ContentBlock。这一步 CLI 做不了，也不该做。
 *
 * 产物固定是「一张九宫格 + 可选 N 张单帧」：
 *   九宫格 = 1 张图覆盖整段（每格带时间戳，最省视觉 token）；
 *   单帧   = 对某几格放大看细节（每张 640×360，来源只有 360p）。
 * 文本默认只取官方字幕（快、准）；`transcript=full` 才走本地转写（慢），`off` 只给元数据。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { cacheDir } from './cache.js'
import { runLook, trimForModel } from './look.js'

const MAX_IMAGES = 4 // 九宫格 + 最多 3 张单帧；再高就会被 imageLimits 拦，也没必要

function parseSheet(stdout) {
  const path = /拼图:\s*(.+?)（/.exec(stdout)
  const legend = /每格时间：(.+)/.exec(stdout)
  // 图例形如「#1=0s  #2=20s  #4=1m00s」，用 \S+ 取值，别只抓数字（会被 s/m 截断成 "1"）。
  const cells = legend
    ? [...legend[1].matchAll(/#(\d+)=([^\s]+)/g)].map((m) => ({ cell: Number(m[1]), mmss: m[2] }))
    : []
  return { sheetPath: path ? path[1].trim() : '', cells }
}

function parseView(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const title = (lines.find((line) => line.startsWith('视频:')) || '').replace(/^视频:\s*/, '')
  const upLine = lines.find((line) => line.startsWith('UP:')) || ''
  const intro = (lines.find((line) => line.startsWith('简介:')) || '').replace(/^简介:\s*/, '')
  return { title, upLine: upLine.replace(/^UP:\s*/, ''), intro }
}

/** 从九宫格 manifest 里拿「第几格 → 哪一帧 → 第几秒」，manifest 缺失时退回扫目录。 */
function readCells(sheetPath, bv, page) {
  const manifestPath = sheetPath.replace(/\.jpg$/, '.manifest.json')
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (Array.isArray(manifest?.cells) && manifest.cells.length) {
      return { dir: framesDir(bv, page, manifest.step), cells: manifest.cells }
    }
  } catch {}
  return { dir: '', cells: [] }
}

function framesDir(bv, page, step) {
  if (!step) return ''
  return join(cacheDir().dir, 'frames', `${bv}-p${page}-${step}s`)
}

function pickExtras(cells, count) {
  if (!Array.isArray(cells) || cells.length === 0 || count <= 0) return []
  const n = Math.min(count, cells.length)
  const picked = []
  for (let i = 0; i < n; i += 1) {
    const index = n === 1 ? 0 : Math.round((i * (cells.length - 1)) / (n - 1))
    picked.push(cells[index])
  }
  return [...new Map(picked.map((cell) => [cell.file, cell])).values()]
}

/**
 * 生成一次 visual 结果：文本 + 已保存为附件的图片引用。
 * @returns {Promise<{ok: boolean, text: string, images: object[], sheetPath: string, frames: string[]}>}
 */
export async function buildVisual(ctx, options = {}) {
  const bv = String(options.bv || '').trim()
  if (!bv) return { ok: false, text: 'visual 需要 bv（BV 号或分享链接）', images: [], sheetPath: '', frames: [] }
  const page = Number.isInteger(options.page) && options.page > 0 ? options.page : 1
  const grid = /^[1-6]x[1-6]$/.test(String(options.grid || '')) ? String(options.grid) : '3x3'
  const step = Number.isFinite(options.step) && options.step > 0 ? Math.floor(options.step) : 0
  const extra = Math.max(0, Math.min(3, Number.isFinite(options.extraFrames) ? Math.floor(options.extraFrames) : 0))
  const transcriptMode = ['auto', 'full', 'off'].includes(options.transcript) ? options.transcript : 'auto'
  const signal = options.signal || null

  const sheetArgs = ['sheet', bv, '--grid', grid, ...(step ? ['--step', String(step)] : [])]
  const viewArgs = ['view', bv]
  const subArgs = ['sub', bv, '--format', 'txt']

  // 三个子进程互不依赖：拼图（要下载）、元数据、字幕并行跑，整体耗时≈最慢的那个。
  const [sheetResult, viewResult, subResult] = await Promise.all([
    runLook(sheetArgs, { signal, timeoutMs: 600_000 }),
    runLook(viewArgs, { signal, timeoutMs: 180_000 }),
    transcriptMode === 'off' ? Promise.resolve(null) : runLook(subArgs, { signal, timeoutMs: 180_000 }),
  ])

  if (sheetResult.code !== 0 || !parseSheet(sheetResult.out).sheetPath) {
    return {
      ok: false,
      text: `抽帧拼图失败：${(sheetResult.err || sheetResult.out || `退出码 ${sheetResult.code}`).trim().slice(0, 600)}`,
      images: [],
      sheetPath: '',
      frames: [],
    }
  }

  const { sheetPath, cells } = parseSheet(sheetResult.out)
  const meta = parseView(viewResult.out)
  const { dir, cells: manifestCells } = readCells(sheetPath, bv, page)
  const chosen = extra > 0 ? pickExtras(manifestCells, extra) : []
  const framePaths = chosen
    .map((cell) => (dir && cell.file ? join(dir, cell.file) : ''))
    .filter((path) => path && existsSync(path))

  // 文本：字幕优先（auto/full 都先试官方字幕）；full 且没字幕时退到 text（含本地转写）。
  let body = ''
  let bodySource = ''
  if (transcriptMode !== 'off' && subResult && subResult.code === 0) {
    const text = String(subResult.out || '').trim()
    if (text) {
      body = text
      bodySource = '官方字幕'
    }
  }
  if (!body && transcriptMode === 'full') {
    const full = await runLook(['text', bv, '--quiet'], { signal, timeoutMs: 1_500_000 })
    if (full.code === 0) {
      body = String(full.out || '').trim()
      bodySource = '本地转写/OCR'
    }
  }

  const seconds = transcriptMode === 'off'
    ? ''
    : body
      ? ''
      : '（没取到官方字幕；需要完整文本可在面板或工具里改用 command=text）'
  const legend = cells.length ? cells.map((cell) => `#${cell.cell}=${cell.mmss}`).join('  ') : ''
  const header = [
    `视频：${meta.title || bv}`,
    meta.upLine ? `${meta.upLine}` : '',
    `九宫格：${grid}（1 张图，覆盖 ${cells.length || '?'} 个时间点${legend ? `；${legend}` : ''}）`,
    extra > 0 ? `附加单帧：${framePaths.map((path) => basename(path)).join('、') || '（无）'}` : '',
    bodySource ? `文本来源：${bodySource}` : '',
  ].filter(Boolean).join('\n')

  const images = await saveImages(ctx, [sheetPath, ...framePaths])

  const textBody = body
    ? trimForModel(body, 'visual', bv, {})
    : seconds
  const text = [
    header,
    textBody,
    images.length
      ? `（本次结果已附带 ${images.length} 张图片；不需要再调用 read_image。要更细的画面就再调 frames + read_image。）`
      : '（图片保存失败，只给了文本；可用 read_image 读上面的拼图路径。）',
    images.length ? '' : `拼图路径：${sheetPath}`,
  ].filter(Boolean).join('\n\n')

  recordVisual({ bv, grid, step, extra, images: images.length, transcript: bodySource })
  return { ok: true, text, images, sheetPath, frames: framePaths }
}

/** 把本地图片存成 DSH 附件；任何一张失败都只跳过它，不影响文本与其它图。 */
async function saveImages(ctx, paths) {
  const attachments = (() => { try { return ctx.get?.('attachments') } catch { return undefined } })()
  if (!attachments?.saveImage) return []
  const limits = attachments.imageLimits || {}
  const maxBytes = Number(limits.maxImageBytes) || 8 * 1024 * 1024
  const maxCount = Math.min(MAX_IMAGES, Number(limits.maxImagesPerMessage) || MAX_IMAGES)
  const refs = []
  for (const path of paths.slice(0, maxCount)) {
    try {
      if (!existsSync(path)) continue
      const data = readFileSync(path)
      if (data.length > maxBytes) continue
      const ref = await attachments.saveImage({ data, mediaType: 'image/jpeg', name: basename(path) })
      if (ref?.attachmentId) refs.push(ref)
    } catch {}
  }
  return refs
}

/** 记一笔到 runs.jsonl，面板「最近一次调用」能看到 visual（与 look.mjs 的日志同源）。 */
function recordVisual(info) {
  try {
    const dir = join(cacheDir().dir, '_logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'runs.jsonl'), `${JSON.stringify({
      at: new Date().toISOString(),
      command: 'visual',
      bv: info.bv,
      ok: info.images > 0,
      grid: info.grid,
      step: info.step,
      extra: info.extra,
      images: info.images,
      transcript: info.transcript || '',
      source: 'host',
    })}\n`, 'utf8')
  } catch {}
}
