/**
 * `visual`：一次调用同时返回「文本稿 + 画面」。
 *
 * 为什么单独一层：CLI 只能把图片写到磁盘、把路径打到 stdout；要把图片**作为工具结果的一部分**
 * 交给多模态模型，必须由宿主把文件变成 DSH 的附件（`attachments.saveImage`）再塞进
 * 工具的 ContentBlock。这一步 CLI 做不了，也不该做。
 *
 * 两种产物形态：
 *   网格图 = 1 张图覆盖一段（每格带时间戳，最省视觉 token）；
 *   帧直附 = 帧数不够铺满网格时，直接把帧作为图片给出（绝不拼空格/黑格）。
 * 文本里写明「请求了什么、实际用了什么、每张图对应第几秒」。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { cacheDir } from './cache.js'
import { runLook, trimForModel } from './look.js'

const MAX_IMAGES = 4 // 网格图 + 最多 3 张单帧
const GRID_RE = /^[1-6]x[1-6]$/

function fmtTime(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0))
  const m = Math.floor(n / 60)
  const s = n % 60
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`
}

function parseTime(value) {
  if (value === undefined || value === null || value === '') return null
  const s = String(value).trim().toLowerCase()
  let m = /^(\d+):(\d{1,2})$/.exec(s)
  if (m) return Number(m[1]) * 60 + Number(m[2])
  m = /^(\d+)m(\d{1,2})s?$/.exec(s)
  if (m) return Number(m[1]) * 60 + Number(m[2])
  const n = Number(s.replace(/s$/, ''))
  return Number.isFinite(n) && n >= 0 ? n : null
}

function parseSheet(stdout) {
  const path = /拼图:\s*(.+?)（/.exec(stdout)
  const quality = /画质:\s*([^\s（]+)/.exec(stdout)
  const cover = /覆盖:\s*(.+)/.exec(stdout)
  const legend = /每格时间：(.+)/.exec(stdout)
  // 图例形如「#1=0s  #2=20s  #4=1m00s」，用 \S+ 取值，别只抓数字（会被 s/m 截断成 "1"）。
  const cells = legend
    ? [...legend[1].matchAll(/#(\d+)=([^\s]+)/g)].map((m) => ({ cell: Number(m[1]), mmss: m[2] }))
    : []
  return {
    sheetPath: path ? path[1].trim() : '',
    cells,
    quality: quality ? quality[1] : '',
    cover: cover ? cover[1].trim() : '',
  }
}

function parseView(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const title = (lines.find((line) => line.startsWith('视频:')) || '').replace(/^视频:\s*/, '')
  const upLine = lines.find((line) => line.startsWith('UP:')) || ''
  return { title, upLine: upLine.replace(/^UP:\s*/, '') }
}

function parseFrameCount(stdout) {
  const m = /帧:\s*(\d+)\s*张/.exec(String(stdout || ''))
  return m ? Number(m[1]) : 0
}

function parseFrameDir(stdout) {
  const m = /目录:\s*(.+)/.exec(String(stdout || ''))
  return m ? m[1].trim() : ''
}

function parseStep(stdout) {
  const m = /间隔:\s*每\s*([^\s]+)\s*一帧/.exec(String(stdout || ''))
  return m ? (parseTime(m[1]) || 0) : 0
}

/** 从网格 manifest 里拿「第几格 → 哪一帧 → 第几秒」。 */
function readCells(sheetPath, frameDir, bv) {
  const manifestPath = sheetPath.replace(/\.jpg$/, '.manifest.json')
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (Array.isArray(manifest?.cells) && manifest.cells.length) {
      return { cells: manifest.cells, start: Number(manifest.start) || 0, step: Number(manifest.step) || 0 }
    }
  } catch {}
  // manifest 缺失：退回按目录 + 文件名顺序（时间未知，宁可写 ?）
  if (frameDir && existsSync(frameDir)) {
    const cells = []
    for (let i = 1; i < 1000; i++) {
      const file = `${bv}-${String(i).padStart(2, '0')}.jpg`
      if (!existsSync(join(frameDir, file))) break
      cells.push({ cell: i, file, sec: null, mmss: '?' })
    }
    return { cells, start: 0, step: 0 }
  }
  return { cells: [], start: 0, step: 0 }
}

function listFrames(frameDir, bv, count) {
  const out = []
  for (let i = 1; i <= Math.max(0, count); i++) {
    const file = `${bv}-${String(i).padStart(2, '0')}.jpg`
    if (existsSync(join(frameDir, file))) out.push(file)
  }
  return out
}

/** 均匀挑 n 个，返回 {file, idx}（idx 用来算时间戳）。 */
function pickEvenIndexed(files, n) {
  if (!files.length || n <= 0) return []
  if (files.length <= n) return files.map((file, idx) => ({ file, idx }))
  const out = []
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i * (files.length - 1)) / Math.max(1, n - 1))
    out.push({ file: files[idx], idx })
  }
  return out
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

function rangeArgs(start, end) {
  const out = []
  const s = String(start ?? '').trim()
  const e = String(end ?? '').trim()
  if (s) out.push('--start', s)
  if (e) out.push('--end', e)
  return out
}

/**
 * 生成一次 visual 结果：文本 + 已保存为附件的图片引用。
 * @returns {Promise<{ok: boolean, text: string, images: object[], sheetPath: string, frames: string[]}>}
 */
export async function buildVisual(ctx, options = {}) {
  const bv = String(options.bv || '').trim()
  if (!bv) return { ok: false, text: 'visual 需要 bv（BV 号或分享链接）', images: [], sheetPath: '', frames: [] }
  const page = Number.isInteger(options.page) && options.page > 0 ? options.page : 1
  const gridRequested = GRID_RE.test(String(options.grid || '')) ? String(options.grid) : '3x3'
  const step = Number.isFinite(options.step) && options.step > 0 ? Math.floor(options.step) : 0
  const quality = [360, 480, 720, 1080].includes(Number(options.quality)) ? Number(options.quality) : 360
  const extraRequested = Number.isFinite(options.extraFrames) ? Math.max(0, Math.floor(options.extraFrames)) : 0
  const extra = Math.min(extraRequested, 3)
  const transcriptMode = ['auto', 'full', 'off'].includes(options.transcript) ? options.transcript : 'auto'
  const attach = options.attach !== false
  const signal = options.signal || null
  const range = rangeArgs(options.start, options.end)

  const sheetArgs = (grid) => ['sheet', bv, '--grid', grid, ...(step ? ['--step', String(step)] : []), '--quality', String(quality), ...range]
  const frameArgs = ['frames', bv, ...(step ? ['--step', String(step)] : []), '--quality', String(quality), ...range]

  // 先抽帧（同时拿到「实际有多少帧」），再决定拼网格还是直附；view / 字幕并行跑。
  const [frameResult, viewResult, subResult] = await Promise.all([
    runLook(frameArgs, { signal, timeoutMs: 1_500_000 }),
    runLook(['view', bv], { signal, timeoutMs: 180_000 }),
    transcriptMode === 'off' ? Promise.resolve(null) : runLook(['sub', bv, '--format', 'txt'], { signal, timeoutMs: 180_000 }),
  ])

  if (frameResult.code !== 0) {
    return {
      ok: false,
      text: `抽帧失败：${(frameResult.err || frameResult.out || `退出码 ${frameResult.code}`).trim().slice(0, 600)}`,
      images: [],
      sheetPath: '',
      frames: [],
    }
  }
  const frameCount = parseFrameCount(frameResult.out)
  const frameDir = parseFrameDir(frameResult.out)
  const frameStep = parseStep(frameResult.out) || step
  const startSec = parseTime(options.start) || 0
  const [gcols, grows] = gridRequested.split('x').map(Number)
  const cellsWanted = gcols * grows

  const meta = parseView(viewResult.out)
  let mode = 'sheet'
  let note = ''
  let sheetPath = ''
  let sheetInfo = { sheetPath: '', cells: [], quality: '', cover: '' }
  let chosen = []

  if (frameCount > 0 && frameCount < cellsWanted) {
    // 帧数不够铺满：不拼空格，直接把帧作为图片给出。
    mode = 'frames'
    const files = listFrames(frameDir, bv, frameCount)
    chosen = pickEvenIndexed(files, Math.min(MAX_IMAGES, files.length)).map(({ file, idx }) => ({
      file,
      mmss: fmtTime(startSec + idx * frameStep),
    }))
    note = `帧数只有 ${frameCount}，${gridRequested} 需要 ${cellsWanted} 格；已改为直接附 ${chosen.length} 张帧（不拼网格、不留黑格）`
  } else {
    const sheetResult = await runLook(sheetArgs(gridRequested), { signal, timeoutMs: 600_000 })
    sheetInfo = parseSheet(sheetResult.out || '')
    if (sheetResult.code !== 0 || !sheetInfo.sheetPath) {
      return {
        ok: false,
        text: `抽帧拼图失败：${(sheetResult.err || sheetResult.out || `退出码 ${sheetResult.code}`).trim().slice(0, 600)}`,
        images: [],
        sheetPath: '',
        frames: [],
      }
    }
    sheetPath = sheetInfo.sheetPath
    const rc = readCells(sheetPath, frameDir, bv)
    chosen = extra > 0 ? pickExtras(rc.cells, extra) : []
  }

  const framePaths = chosen
    .map((cell) => (frameDir && cell.file ? join(frameDir, cell.file) : ''))
    .filter((path) => path && existsSync(path))

  // 文本：字幕优先（auto/full 都先试官方字幕）；full 且没字幕时退到 text（含本地转写）。
  let body = ''
  let bodySource = ''
  if (transcriptMode !== 'off' && subResult && subResult.code === 0) {
    const text = String(subResult.out || '').trim()
    if (text) {
      body = text
      bodySource = 'B站字幕接口（不区分 UP 上传 / 自动生成）'
    }
  }
  if (!body && transcriptMode === 'full') {
    const full = await runLook(['text', bv, '--quiet', ...range], { signal, timeoutMs: 1_800_000 })
    if (full.code === 0) {
      body = String(full.out || '').trim()
      bodySource = '本地转写/OCR'
    }
  }

  // 「标记关键帧」：图片在结果里是有序的，文本按同样顺序写出每张对应第几秒。
  const frameLegend = chosen
    .map((cell, index) => (mode === 'frames' ? `图 ${index + 1} = ${cell.mmss}` : `单帧 ${index + 1} = ${cell.mmss}`) + (cell.file ? `（${cell.file}）` : ''))
    .join('\n')
  const sheetLegend = sheetInfo.cells.length
    ? sheetInfo.cells.map((cell) => `#${cell.cell}=${cell.mmss}`).join('  ')
    : ''
  const header = [
    `视频：${meta.title || bv}`,
    meta.upLine ? `${meta.upLine}` : '',
    mode === 'sheet'
      ? `网格：${gridRequested}（1 张图，覆盖 ${sheetInfo.cells.length || '?'} 个时间点${sheetLegend ? `：${sheetLegend}` : ''}）`
      : `画面：直接附 ${chosen.length} 张帧（未拼网格）`,
    note ? `（${note}）` : '',
    sheetInfo.cover ? `覆盖：${sheetInfo.cover}` : (Number(step) || frameStep) ? `覆盖：从 ${fmtTime(startSec)} 起，每 ${fmtTime(frameStep)} 一帧` : '',
    `画质：${sheetInfo.quality || `${quality}p`}${frameStep ? ` · 每 ${frameStep}s 一帧` : ''}`,
    extraRequested > extra ? `（请求 ${extraRequested} 张单帧，上限 ${extra}，已截断）` : '',
    chosen.length ? `${mode === 'sheet' ? (attach ? '附加单帧（紧随网格图之后，按顺序）' : '单帧（未附图，路径见下，按顺序）') : '附图（紧随文本之后，按顺序）'}：\n${frameLegend}` : '',
    quality > 360 && extra === 0 && mode === 'sheet' ? '（提示：网格每格固定按 640 宽拼，画质主要影响单帧；要看细节请加 extraFrames。）' : '',
    bodySource ? `文本来源：${bodySource}` : '',
  ].filter(Boolean).join('\n')

  const imagePaths = mode === 'sheet' ? [sheetPath, ...framePaths] : framePaths
  const images = attach ? await saveImages(ctx, imagePaths) : []

  const textBody = body
    ? trimForModel(body, 'visual', bv, {})
    : (transcriptMode === 'off' ? '' : '（没取到官方字幕；需要完整文本可改用 command=text，或 transcript=full 跑本地转写）')
  const text = [
    header,
    textBody,
    images.length
      ? `（本次结果已附带 ${images.length} 张图片；不需要再调用 read_image。要更细的画面就再调 frames + read_image。）`
      : attach
        ? '（图片保存失败，只给了文本；可用 read_image 读下面的路径。）'
        : `（attach=false：只给路径，没有附图。）\n${mode === 'sheet' ? `网格图：${sheetPath}` : ''}${framePaths.length ? `\n帧：${framePaths.join('\n')}` : ''}`,
    attach && !images.length && (sheetPath || framePaths.length) ? `路径：${[sheetPath, ...framePaths].filter(Boolean).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')

  recordVisual({ bv, grid: mode === 'sheet' ? gridRequested : `frames-${chosen.length}`, step: frameStep, extra, images: images.length, transcript: bodySource })
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
