/**
 * 调用插件自带的只读工具 tools/look.mjs，并把超长文本收敛成「摘要 + 全文路径」。
 *
 * 子进程的一切都归这里管：超时、取消（模型点停止）、Windows 进程树替换、
 * 失败现场（runs.jsonl / last-error.json），以及给模型看的截断口径。
 */
import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HERE, readTuning, writeLastRun } from './config.js'
import { cacheDir } from './cache.js'

export const LOOK = join(HERE, 'tools', 'look.mjs')

const RUNS_DIR = () => join(cacheDir().dir, '_logs')
const RUNS_FILE = () => join(RUNS_DIR(), 'runs.jsonl')

let fileSeq = 0

/** 只留字母数字与 `_ . -`；挡掉 `..`、`/` 与 Windows 保留设备名。 */
export function cleanKey(value) {
  const key = String(value || '').replace(/[^\w.-]/g, '').slice(0, 40).replace(/[\s.]+$/, '')
  const base = key.split('.')[0]
  if (!key || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(base)) return '_misc'
  return key
}

/** 按视频分目录：<cache>/<BV>/ —— 同一视频各命令的输出收在一处。 */
export function videoDir(key) {
  const bv = /(BV[0-9A-Za-z]{10})/.exec(String(key || ''))
  const base = cleanKey(bv ? bv[1] : key)
  const root = cacheDir().dir
  mkdirSync(root, { recursive: true })
  try {
    for (const entry of readdirSync(root)) {
      if (entry === base || entry.startsWith(`${base}_`)) return join(root, entry)
    }
  } catch {}
  const dir = join(root, base)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 按码点截断：emoji 是代理对，slice 会切出 U+FFFD。 */
function cutByCodePoint(text, limit) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  const points = Array.from(value)
  return points.length <= limit ? value : points.slice(0, limit).join('')
}

/**
 * 长文本 → 落盘 + 摘要。短文本原样返回。
 * JSON 类输出超长时整份落盘、不切半截（半截 JSON 不能 parse，还会被模型误读）。
 */
export function trimForModel(text, tag = 'out', bv = '', opts = {}) {
  const value = String(text ?? '')
  let file = ''
  try {
    const base = String(tag || 'out').replace(/[^\w.-]/g, '') || 'out'
    const name = `${base}.${Date.now().toString(36)}${(++fileSeq).toString(36)}`
    file = join(videoDir(bv), `${name}.tool.txt`)
    writeFileSync(file, value, 'utf8')
  } catch {
    file = ''
  }
  if (!file) return value
  const tuning = readTuning()
  const cap = opts.full ? 20_000 : tuning.toolTextCap
  const head = Number.isFinite(opts.head) && opts.head > 0
    ? Math.floor(opts.head)
    : (opts.full ? 20_000 : tuning.toolHead)
  if (value.length <= cap) return value
  const bare = value.replace(/^\[source:[^\]]*\]\s*/, '')
  if (opts.json || /^\s*[{[]/.test(bare)) {
    return `（全文 ${value.length} 字，超限；JSON 已整份落盘，不要对下面的内容做 JSON.parse。已存：${file}）`
  }
  return `${cutByCodePoint(value, head)}\n\n…（全文 ${value.length} 字，只回了前 ${head} 字；全文已存：${file}）\n要看完整版：用 read 工具打开上面的文件（别再跑一遍命令）。`
}

/** 杀整棵进程树：Windows 用 taskkill，其他平台靠 detached 进程组。 */
function killTree(child) {
  if (!child?.pid) return
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(-child.pid, 'SIGKILL')
    }
  } catch {}
}

/**
 * 跑一次 look.mjs。
 * @returns {Promise<{code:number, out:string, err:string, ms:number}>}
 */
export function runLook(args, { timeoutMs = 1_200_000, signal = null } = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    const outChunks = []
    const errChunks = []
    let settled = false
    let child = null
    let timer = null

    const out = () => Buffer.concat(outChunks).toString('utf8')
    const err = () => Buffer.concat(errChunks).toString('utf8')

    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener?.('abort', onAbort)
      resolve({ ...result, ms: Date.now() - started })
    }
    const onAbort = () => {
      killTree(child)
      finish({ code: -3, out: out().trim(), err: '已被用户取消' })
    }

    try {
      child = spawn(process.execPath, [LOOK, ...args], {
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          // 子进程与宿主读同一份缓存根，避免两边各算一个目录。
          BILI_WATCH_CACHE: cacheDir().dir,
        },
      })
    } catch (error) {
      finish({ code: -1, out: '', err: `启动失败：${String(error?.message || error)}` })
      return
    }

    timer = setTimeout(() => {
      killTree(child)
      finish({ code: -2, out: out().trim(), err: `${err()}\n[超时 ${Math.round(timeoutMs / 1000)}s]`.trim() })
    }, timeoutMs)

    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (chunk) => outChunks.push(chunk))
    child.stderr.on('data', (chunk) => errChunks.push(chunk))
    child.on('error', (error) => finish({ code: -1, out: out().trim(), err: String(error?.message || error) }))
    child.on('close', (code) => finish({ code: code ?? -1, out: out().trim(), err: err().trim() }))
  })
}

/** 记录一次调用：成功写 last-run.json，失败额外写 <video>/last-error.json。 */
export function recordRun({ command, bv = '', argv = [], code = 0, signal = null, ms = 0, stderr = '' }) {
  try {
    writeLastRun(command, code, ms)
    const entry = {
      at: new Date().toISOString(),
      command,
      bv: String(bv || ''),
      argv,
      code,
      signal,
      ms,
      ok: code === 0,
    }
    if (!entry.ok) {
      entry.stderr = String(stderr || '').slice(-4000)
      if (/^BV[0-9A-Za-z]{10}$/.test(entry.bv)) {
        try { writeFileSync(join(videoDir(entry.bv), 'last-error.json'), `${JSON.stringify(entry, null, 2)}\n`, 'utf8') } catch {}
      }
    }
    mkdirSync(RUNS_DIR(), { recursive: true })
    const file = RUNS_FILE()
    try {
      const stat = statSync(file)
      const lines = Math.max(1, readFileSync(file, 'utf8').split('\n').length - 1)
      if (stat.size > 5 * 1024 * 1024 || lines > 2000) {
        try { rmSync(`${file}.1`, { force: true }) } catch {}
        try { renameSync(file, `${file}.1`) } catch {}
      }
    } catch {}
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {}
}

/** 日志尾部（面板「最近调用」里可以展开看）。 */
export function recentRuns(limit = 5) {
  try {
    const lines = readFileSync(RUNS_FILE(), 'utf8').trim().split('\n').slice(-limit)
    return lines.map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch {
    return []
  }
}

export function hasLook() {
  return existsSync(LOOK)
}
