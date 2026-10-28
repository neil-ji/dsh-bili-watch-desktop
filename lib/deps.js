/**
 * 可选依赖：探测、一键下载、删除。
 *
 * 探测原则（重构重点）：/status 每 10 秒被面板轮询一次，绝不能在里面
 * 跑 `ffmpeg -version` / `yt-dlp --version` 这类同步子进程——原来的实现会
 * 阻塞宿主事件循环 1 秒以上。这里只查文件系统，并且把目录体积缓存 60 秒。
 */
import { spawn, execFile } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEPS, HERE, RUN_DIR, addWarning, depsCfg, ensureDir, statOrNull } from './config.js'
import { credState, deleteCredential } from './cred.js'

const IS_WIN = process.platform === 'win32'
const PY_DIR = IS_WIN ? 'Scripts' : 'bin'
const PY_EXE = IS_WIN ? 'python.exe' : 'python'

/** 面板上的预估体积，只用于显示。 */
const ESTIMATES = {
  ffmpeg: '约 94 MB',
  ytdlp: '约 17 MB',
  asr: '约 294 MB',
  ocr: '约 263 MB',
  model: '约 464 MB',
}

const DOWNLOAD_LOG = join(RUN_DIR, 'download.log')

function projDir() {
  return process.env.BILI_WATCH_PROJ || depsCfg().proj || DEPS
}

function firstExisting(paths) {
  return paths.find((path) => path && existsSync(path)) || ''
}

/** venv 的 site-packages 候选（Windows 是 Lib，POSIX 是 lib/python3.x）。 */
function sitePackagesOf(venvPython) {
  const root = resolve(venvPython, '..', '..')
  const candidates = [join(root, 'Lib', 'site-packages')]
  try {
    for (const name of readdirSync(join(root, 'lib'))) {
      if (name.startsWith('python')) candidates.push(join(root, 'lib', name, 'site-packages'))
    }
  } catch {}
  return candidates
}

/**
 * venv 里是否真的装上了某个包。
 * 只看 python.exe 会把「venv 刚建好、pip 还没装完」判成已就绪——安装过程中面板就会显示
 * 「5/6 就绪」，可这两个环境其实还在 8%。这里按 site-packages 里的目录名核对。
 */
function hasPackage(venvPython, pkg) {
  if (!venvPython) return false
  for (const dir of sitePackagesOf(venvPython)) {
    try {
      const names = readdirSync(dir)
      if (names.some((name) => name === pkg || (name.startsWith(`${pkg}-`) && name.endsWith('.dist-info')))) return true
    } catch {}
  }
  return false
}

export function venvAsr() {
  const python = firstExisting([join(DEPS, '.venv-asr', PY_DIR, PY_EXE), join(projDir(), '.venv-asr', PY_DIR, PY_EXE)])
  return python && hasPackage(python, 'faster_whisper') ? python : ''
}

export function venvOcr() {
  const python = firstExisting([join(DEPS, '.venv-ocr', PY_DIR, PY_EXE), join(projDir(), '.venv-ocr', PY_DIR, PY_EXE)])
  return python && hasPackage(python, 'rapidocr_onnxruntime') ? python : ''
}

/** 模型目录只有在快照里真的有权重文件时才算就绪（下载中途 `.hf-home` 就已经存在了）。 */
export function modelHome() {
  const home = firstExisting([join(DEPS, '.hf-home'), join(projDir(), '.hf-home')])
  if (!home) return ''
  try {
    const hub = join(home, 'hub')
    for (const model of readdirSync(hub)) {
      if (!model.startsWith('models--')) continue
      const snapshots = join(hub, model, 'snapshots')
      for (const snapshot of readdirSync(snapshots)) {
        const files = readdirSync(join(snapshots, snapshot))
        if (files.some((file) => /\.(bin|pt|safetensors)$/i.test(file))) return home
      }
    }
  } catch {}
  return ''
}

export function ytdlpPath() {
  return join(DEPS, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp')
}

/** ffmpeg 候选：--ffmpeg / 环境变量 / 配置 / deps 自带 / PATH。 */
export function ffmpegCandidates() {
  return [
    depsCfg().ffmpeg,
    join(DEPS, IS_WIN ? 'ffmpeg.exe' : 'ffmpeg'),
    'ffmpeg',
  ].filter(Boolean)
}

/** PATH 里 ffmpeg 的探测结果（异步一次，避免每次状态轮询都 spawn）。 */
let pathProbe = { at: 0, ok: false, path: '' }

export function resolveFfmpeg() {
  const env = process.env.BILI_WATCH_FFMPEG
  if (env && existsSync(env)) return env
  for (const candidate of ffmpegCandidates()) {
    if (candidate === 'ffmpeg') continue
    if (existsSync(candidate)) return candidate
  }
  // PATH 里的 ffmpeg：只在 probeFfmpeg() 已经确认可执行时才认，轮询本身绝不 spawn。
  if (pathProbe.ok && Date.now() - pathProbe.at < 10 * 60_000) return 'ffmpeg'
  return ''
}

const dirSizeCache = new Map()

/** 目录体积（缓存 60 秒；venv 动辄上万文件，不能每次轮询都走一遍）。 */
function dirSize(dir) {
  if (!dir) return 0
  const hit = dirSizeCache.get(dir)
  if (hit && Date.now() - hit.at < 60_000) return hit.bytes
  let bytes = 0
  const walk = (current) => {
    let entries
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else { try { bytes += statSync(path).size } catch {} }
    }
  }
  walk(dir)
  dirSizeCache.set(dir, { at: Date.now(), bytes })
  return bytes
}

let snapshotCache = { at: 0, value: null }

/** 面板依赖清单。纯文件系统检查，惰性缓存 20 秒。 */
export function depRows() {
  if (snapshotCache.value && Date.now() - snapshotCache.at < 20_000) return snapshotCache.value
  const ffmpeg = resolveFfmpeg()
  const ytdlp = ytdlpPath()
  const asr = venvAsr()
  const ocr = venvOcr()
  const model = modelHome()
  const rows = [
    {
      id: 'ffmpeg',
      name: 'ffmpeg',
      hint: '抽帧、取音轨',
      ok: Boolean(ffmpeg),
      detail: ffmpeg
        ? (ffmpeg === 'ffmpeg' ? '系统 PATH（ffmpeg -version 可用）' : ffmpeg)
        : '未找到；抽帧与本地转写会失败（元数据、评论、弹幕不受影响）',
      path: ffmpeg || '',
      removable: false,
      removableWhy: '系统或用户自备，插件不删',
      size: ffmpeg ? (dirSizeOfFile(ffmpeg)) : 0,
      estimate: ESTIMATES.ffmpeg,
    },
    {
      id: 'ytdlp',
      name: 'yt-dlp',
      hint: '通用 URL（非 B 站）',
      ok: existsSync(ytdlp),
      detail: existsSync(ytdlp) ? ytdlp : '未找到；非 B 站链接不可用',
      path: ytdlp,
      removable: true,
      size: dirSizeOfFile(ytdlp),
      estimate: ESTIMATES.ytdlp,
    },
    {
      id: 'asr',
      name: '本地转写环境',
      hint: 'faster-whisper',
      ok: Boolean(asr),
      detail: asr || '未安装；没有字幕的视频无法转写',
      path: asr,
      removable: false,
      removableWhy: '环境目录不从这里删（重装代价比省下的空间大）',
      size: asr ? dirSize(join(asr, '..', '..')) : 0,
      estimate: ESTIMATES.asr,
    },
    {
      id: 'ocr',
      name: '画面 OCR 环境',
      hint: 'rapidocr',
      ok: Boolean(ocr),
      detail: ocr || '未安装；只能抽帧，不能识别画面文字',
      path: ocr,
      removable: false,
      removableWhy: '环境目录不从这里删（重装代价比省下的空间大）',
      size: ocr ? dirSize(join(ocr, '..', '..')) : 0,
      estimate: ESTIMATES.ocr,
    },
    {
      id: 'model',
      name: '转写模型',
      hint: 'faster-whisper small',
      ok: Boolean(model),
      detail: model || '未下载；本地转写不可用',
      path: model,
      removable: true,
      size: model ? dirSize(model) : 0,
      estimate: ESTIMATES.model,
    },
  ]
  const cred = credState()
  rows.push({
    id: 'credential',
    name: 'B 站登录',
    hint: 'AI 字幕需要',
    ok: cred.state === 'ok',
    detail: !cred.exists
      ? '未登录；AI 字幕与部分接口不可用（其余功能匿名可用）'
      : cred.state === 'incomplete'
        ? `凭证不完整（缺 ${cred.missing.join('/')}），实际按匿名运行`
        : `更新于 ${String(cred.updatedAt || '').slice(0, 19).replace('T', ' ')}`,
    path: cred.path,
    removable: cred.exists,
    size: cred.exists ? dirSizeOfFile(cred.path) : 0,
    estimate: '扫码登录',
    state: cred.state,
  })
  snapshotCache = { at: Date.now(), value: rows }
  return rows
}

function dirSizeOfFile(path) {
  const stat = statOrNull(path)
  return stat?.isFile() ? stat.size : 0
}

// ── 下载 ────────────────────────────────────────────────────────────────────
const ALLOWED_TARGETS = new Set(['ffmpeg', 'ytdlp', 'asr', 'ocr', 'model', 'all'])
/** 正在跑的下载：target → { pid, startedAt }。 */
const running = new Map()
let lastFinished = null

function scriptPath() {
  return join(HERE, 'scripts', IS_WIN ? 'fetch-deps.ps1' : 'fetch-deps.sh')
}

/**
 * Windows PowerShell 5.1 按 ANSI 解码无 BOM 的 .ps1：中文注释会变乱码，
 * 甚至把字符串里的引号吞掉导致整份脚本解析失败（实测报 UnexpectedToken）。
 * 编辑器/打包工具很容易把 BOM 抹掉，所以在真正执行前补一次，缺了就补回去。
 */
function ensureScriptBom() {
  if (!IS_WIN) return
  try {
    const file = scriptPath()
    const bytes = readFileSync(file)
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return
    writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]))
    logLine('已为 fetch-deps.ps1 补回 UTF-8 BOM（PowerShell 5.1 需要）')
  } catch {}
}

function logLine(text) {
  try {
    ensureDir(RUN_DIR)
    appendFileSync(DOWNLOAD_LOG, `[${new Date().toISOString()}] ${text}\n`, 'utf8')
  } catch {}
}

/**
 * 启动一个依赖安装任务（后台、detached、不阻塞宿主）。
 * target 必须在白名单里；脚本路径固定在包内，不接受前端传路径。
 */
export function startDownload(targets, options = {}) {
  const list = (Array.isArray(targets) ? targets : [targets]).map(String).filter((item) => item)
  const mirror = options.mirror === 'cn' ? 'cn' : ''
  const started = []
  const rejected = []
  if (list.length) lastFinished = null
  for (const target of list) {
    if (!ALLOWED_TARGETS.has(target)) {
      rejected.push({ target, why: `不支持的依赖：${target}` })
      continue
    }
    if (running.has(target)) {
      rejected.push({ target, why: '已经在下载了' })
      continue
    }
    const script = scriptPath()
    if (!existsSync(script)) {
      rejected.push({ target, why: `插件目录里没有 ${script.split(/[\\/]/).pop()}` })
      continue
    }
    ensureScriptBom()
    logLine(`开始安装 ${target}${mirror ? '（镜像 cn）' : ''}`)
    const command = IS_WIN ? 'powershell.exe' : 'bash'
    const args = IS_WIN
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Target', target, ...(mirror ? ['-Mirror', mirror] : [])]
      : [script, target]
    const childEnv = { ...process.env, ...(mirror ? { BILI_WATCH_MIRROR: mirror } : {}) }
    let child
    try {
      child = spawn(command, args, {
        windowsHide: true,
        // 进度条依赖脚本自己打印的阶段行（"==> ..." / "下载 ..." / pip 的 Collecting），
        // 所以这里必须接管 stdout/stderr；原来 stdio:'ignore' 等于把进度全丢了。
        stdio: ['ignore', 'pipe', 'pipe'],
        // 注意：Windows 上不能 detached——DETACHED_PROCESS 下 powershell.exe 没有控制台，
        // 会在 60ms 内直接退出（退出码 0、无输出），看起来像「装完了」其实什么都没做。
        detached: process.platform !== 'win32',
        cwd: HERE,
        env: childEnv,
      })
    } catch (error) {
      logLine(`启动失败 ${target}：${String(error?.message || error)}`)
      rejected.push({ target, why: String(error?.message || error) })
      continue
    }
    const info = { target, pid: child.pid, startedAt: Date.now(), percent: 4, stage: '启动中…', errorLine: '' }
    running.set(target, info)
    const onData = (chunk) => {
      const text = String(chunk)
      for (const raw of text.split(/\r?\n|\r/)) {
        const line = raw.trim()
        if (!line) continue
        // curl/pip 的进度条在管道里会退化成「0 0 0 … 00:09」这类纯数字行，不是阶段信息。
        if (!/[\p{L}]/u.test(line)) continue
        logLine(line)
        // 「==> 步骤标题」只用来推进百分比：它和左侧依赖名重复，显示出来就是同一句话说两遍。
        if (!/^==>/.test(line)) info.stage = cleanStage(line)
        if (/curl:|Connection|reset|超时|timeout|失败|Error|error|Exception|Traceback|拒绝|403|404/.test(line)) {
          info.errorLine = clipLine(line)
        }
        const hit = progressFromLine(line)
        if (hit) {
          info.percent = Math.max(info.percent, hit.percent)
          if (hit.stage) info.stage = hit.stage
        }
        const tqdm = tqdmPercent(line)
        if (tqdm !== null) info.percent = Math.max(info.percent, Math.round(tqdm))
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (error) => {
      running.delete(target)
      lastFinished = { target, ok: false, at: Date.now(), percent: info.percent, stage: clipLine(String(error?.message || error)) }
      logLine(`启动失败 ${target}：${String(error?.message || error)}`)
    })
    child.on('exit', (code) => {
      running.delete(target)
      dirSizeCache.clear()
      snapshotCache = { at: 0, value: null }
      // 退出码 0 不代表装上了：脚本可能因为环境原因什么都没做（例如上面那个 detached 坑）。
      // 装完再核对一次文件，没有新文件就按失败报，别给用户「✓ 已安装」的错觉。
      const verified = code === 0 ? verifyTarget(target) : { ok: false, why: `退出码 ${code}` }
      lastFinished = {
        target,
        ok: code === 0 && verified.ok,
        code,
        at: Date.now(),
        percent: code === 0 && verified.ok ? 100 : info.percent,
        stage: code === 0
          ? (verified.ok ? '完成' : `脚本已退出，但没检测到新文件（${verified.why || '可查看日志'}）`)
          : (info.errorLine || info.stage || `退出码 ${code}`),
      }
      logLine(`完成 ${target}（退出码 ${code}）${verified.ok ? '' : `：${verified.why || '未检测到新文件'}`}`)
    })
    child.unref()
    started.push(target)
  }
  return { started, rejected }
}

function clipLine(line) {
  const text = String(line || '').trim()
  return text.length > 110 ? `${text.slice(0, 110)}…` : text
}

/**
 * 进度条行净化：pip / huggingface 的 tqdm 在管道里会带一堆方块字符（UTF-8 被按单字节解码后的 U+FFFD），
 * 直接显示是乱码。这里砍掉 `|...|` 之间的条，只留「Fetching 6 files: 50%」这样的前缀。
 */
function cleanStage(line) {
  return clipLine(String(line).replace(/\uFFFD+/g, '').replace(/\|[^|]*\|.*$/, '').replace(/\s+/g, ' ').trim())
}

/** 从 tqdm 行里取百分比（30%–80% 区间），让模型下载也有可见进展。 */
function tqdmPercent(line) {
  const match = /(\d{1,3})%\|/.exec(String(line))
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? 30 + Math.min(100, value) * 0.5 : null
}

/** 安装脚本退出后核对产物；`all` 只要有一项新出现就算通过。 */
function verifyTarget(target) {
  const checks = {
    ffmpeg: () => Boolean(resolveFfmpeg()) || existsSync(join(DEPS, IS_WIN ? 'ffmpeg.exe' : 'ffmpeg')),
    ytdlp: () => existsSync(ytdlpPath()),
    asr: () => Boolean(venvAsr()),
    ocr: () => Boolean(venvOcr()),
    model: () => Boolean(modelHome()),
  }
  if (target === 'all') {
    const results = Object.entries(checks).map(([key, check]) => [key, check()])
    const hit = results.filter(([, ok]) => ok)
    return hit.length ? { ok: true } : { ok: false, why: '五项都没检测到' }
  }
  const check = checks[target]
  if (!check) return { ok: true }
  return check() ? { ok: true } : { ok: false, why: '安装位置没有文件' }
}

/** 脚本的阶段行 → 百分比。拿不到阶段行时，percent 由「已用时间 / 预估时长」兜底推进。 */
function progressFromLine(line) {
  const text = String(line)
  if (/^==>/.test(text)) return { percent: 8, stage: '' }
  if (/^\s*下载\s/.test(text) || /下载\s\S+\s*\.\.\.$/.test(text)) return { percent: 20, stage: cleanStage(text) }
  if (/Collecting |Using cached|Downloading https?:/.test(text)) return { percent: 45, stage: cleanStage(text) }
  if (/Installing collected packages/.test(text)) return { percent: 72, stage: cleanStage(text) }
  if (/Successfully installed/.test(text)) return { percent: 88, stage: cleanStage(text) }
  if (/Fetching files/.test(text)) return { percent: 62, stage: cleanStage(text) }
  if (/✓/.test(text)) return { percent: 94, stage: cleanStage(text) }
  return null
}

/** 各依赖的粗略耗时（秒），只用于估算进度并让进度条在无输出时也能爬。 */
const EST_SECONDS = { ffmpeg: 90, ytdlp: 25, asr: 150, ocr: 120, model: 240, all: 300 }

export function downloadState() {
  return {
    running: [...running.entries()].map(([target, info]) => {
      const elapsed = (Date.now() - info.startedAt) / 1000
      const estimate = EST_SECONDS[target] || 90
      // 阶段行给的百分比是「下界」，时间估算让它平滑上涨，两者取大；封顶 95 直到进程退出。
      const creep = 6 + (elapsed / estimate) * 80
      const percent = Math.round(Math.min(95, Math.max(info.percent, creep)))
      return { target, startedAt: info.startedAt, percent, stage: info.stage || '安装中…', bytes: runningBytes(target) }
    }),
    last: lastFinished,
    log: DOWNLOAD_LOG,
    tail: readLogTail(6),
  }
}

/** 日志末尾几行：进程退出后「到底卡在哪一步」还能在面板上看到。 */
function readLogTail(lines) {
  try {
    const raw = readFileSync(DOWNLOAD_LOG, 'utf8')
    return raw.trimEnd().split(/\r?\n/).slice(-lines).map((line) => line.replace(/^\[[^\]]+\]\s*/, ''))
  } catch {
    return []
  }
}

/** 正在下载的二进制已落盘的字节数（只有 yt-dlp 这类「直接写目标文件」的能拿到）。 */
function runningBytes(target) {
  try {
    if (target !== 'ytdlp') return 0
    return statSync(`${ytdlpPath()}.part`).size
  } catch {
    return 0
  }
}

/** 结束页：进程退出后必须把 running 清掉，避免面板永远转圈。 */
export function clearStaleRunning() {
  for (const [target, info] of running) {
    if (Date.now() - info.startedAt > 30 * 60_000) {
      running.delete(target)
      addWarning(`依赖安装 ${target} 超过 30 分钟仍未结束，已从运行列表移除（可查 ${DOWNLOAD_LOG}）`)
    }
  }
}

// ── 删除 ────────────────────────────────────────────────────────────────────
/**
 * 只删插件自己装的东西：yt-dlp、转写模型、登录凭证。
 * ffmpeg / 两个 Python 环境一律不动（理由在 removableWhy 里给用户看）。
 */
export function deleteDeps(targets) {
  const deleted = []
  const skipped = []
  for (const raw of Array.isArray(targets) ? targets : []) {
    const target = String(raw || '')
    if (target === 'credential') {
      const result = deleteCredential()
      if (result.ok) deleted.push(target)
      else skipped.push({ id: target, why: result.why || '删除失败' })
      continue
    }
    const path = target === 'ytdlp' ? ytdlpPath() : target === 'model' ? modelHome() : ''
    if (!path) {
      skipped.push({ id: target, why: '不在插件目录内，不能从这里删' })
      continue
    }
    if (!existsSync(path)) {
      skipped.push({ id: target, why: '本来就不存在' })
      continue
    }
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3 })
      dirSizeCache.clear()
      snapshotCache = { at: 0, value: null }
      deleted.push(target)
    } catch (error) {
      skipped.push({ id: target, why: String(error?.message || error) })
    }
  }
  return { deleted, skipped }
}

/** 异步探一次 ffmpeg 是否真的可执行；结果缓存 10 分钟，供 /status 判断「PATH 里有」。 */
export function probeFfmpeg() {
  return new Promise((resolve) => {
    const found = resolveFfmpeg()
    if (found && found !== 'ffmpeg') {
      pathProbe = { at: Date.now(), ok: false, path: '' }
      return resolve({ ok: true, path: found, source: 'file' })
    }
    execFile('ffmpeg', ['-version'], { timeout: 2500, windowsHide: true }, (error) => {
      pathProbe = error
        ? { at: Date.now(), ok: false, path: '' }
        : { at: Date.now(), ok: true, path: 'ffmpeg' }
      snapshotCache = { at: 0, value: null }
      if (error) return resolve({ ok: false, why: 'PATH 里也没有 ffmpeg' })
      resolve({ ok: true, path: 'ffmpeg', source: 'PATH' })
    })
  })
}
