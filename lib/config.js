/**
 * 路径、配置文件与可调参数。
 *
 * 这一层只做「读盘 / 写盘 / 校验」，不碰网络、不起子进程，方便单独测。
 * 口径与原版保持一致：CLI（tools/look.mjs）和宿主（index.js）读同一份
 * `deps/deps-config.json`，面板改完下一次调用立即生效，不需要重启。
 *
 * 桌面端重构的三处改动：
 *   ① 所有写盘走「临时文件 + rename」，Electron 被强杀也不会留下半截 JSON；
 *   ② 坏文件只备份一次并按默认值继续，同时在面板里留一条告警；
 *   ③ 用户可见的调优项收敛为一张表（面板与校验共用），不再两边手抄。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_DIR = dirname(fileURLToPath(import.meta.url))

/** 插件包根目录（index.js / client.js / tools / deps 都在这一层）。 */
export const HERE = resolve(LIB_DIR, '..')
/** 依赖与配置所在目录（跟着插件包走，和 CLI 同源）。 */
export const DEPS = join(HERE, 'deps')
/** DSH 家目录；缓存与登录凭证放在这里，卸载插件不丢。 */
export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
export const RUN_DIR = join(DSH_HOME, 'bili-watch')
export const CRED_FILE = join(RUN_DIR, 'credential.json')
export const DEFAULT_CACHE_DIR = join(RUN_DIR, 'cache')
/** 缓存根标记：只有我们自己写过它，才敢把目录当成「本插件的缓存根」。 */
export const CACHE_MARK = '.bili-watch-root'
/** 我们自己会在缓存根下创建的目录名。 */
export const OWN_CACHE_DIRS = new Set([
  '_logs', 'frames', 'sheets', 'sheet-tmp', 'substrip-tmp', '_misc', 'asr', 'frames-dl', 'audio-dl', '_hot',
])

const DEPS_CFG = join(DEPS, 'deps-config.json')
const CACHE_CFG = join(DEPS, 'cache-config.json')
const UI_CFG = join(DEPS, 'ui-config.json')
const LAST_RUN = join(DEPS, 'last-run.json')

/** 一次性告警（配置损坏、目录不可写等），由 /status 带给面板。 */
const warnings = new Set()

export function addWarning(text) {
  const value = String(text || '').trim()
  if (value) warnings.add(value)
  return value
}

export function warningsSnapshot() {
  return [...warnings].slice(0, 8)
}

/** 每次激活先清一次：上一次运行留下的告警不该一直挂在面板上。 */
export function resetWarnings() {
  warnings.clear()
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 原子写：先写同目录临时文件再 rename，避免半截 JSON。 */
function writeJsonAtomic(path, value) {
  ensureDir(dirname(path))
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, path)
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch {}
    throw error
  }
}

/**
 * 读一个 JSON 对象文件。文件不存在算正常；解析失败时改名留档（只留一次），
 * 返回默认值并把原因记进 warnings。
 */
function readJsonObject(path, fallback, label) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') addWarning(`${label} 读取失败：${describe(error)}`)
    return { ...fallback }
  }
  if (!raw.trim()) return { ...fallback }
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { ...fallback }
  } catch (error) {
    const backup = `${path}.broken-${Date.now().toString(36)}`
    try {
      renameSync(path, backup)
      addWarning(`${label} 解析失败（${describe(error)}），原文件已备份为 ${backup.split(/[\\/]/).pop()}，本次按默认值继续`)
    } catch {
      addWarning(`${label} 解析失败（${describe(error)}），且备份失败，本次按默认值继续`)
    }
    return { ...fallback }
  }
}

function describe(error) {
  return String(error?.message || error || '未知错误')
}

// ── deps/deps-config.json ────────────────────────────────────────────────────
export function depsCfg() {
  return readJsonObject(DEPS_CFG, {}, 'deps-config.json')
}

/** 合并写：只改传入的键，其他配置原样保留。 */
export function writeDepsCfg(patch) {
  try {
    const next = { ...depsCfg(), ...patch }
    writeJsonAtomic(DEPS_CFG, next)
    return { ok: true, data: next }
  } catch (error) {
    return { ok: false, why: describe(error) }
  }
}

// ── 参数表 ──────────────────────────────────────────────────────────────────
/**
 * 面板可调的数值参数。键名与 tools/look.mjs 的 TUNING_DEFS 一致；
 * min/max 同时用于服务端校验与面板提示，两边不再各写一份。
 */
export const TUNING_DEFS = {
  asrMaxSec: { def: 1800, min: 300, max: 3600, unit: '秒', group: 'basic' },
  maxFrames: { def: 500, min: 100, max: 1000, unit: '张', group: 'basic' },
  asrTimeoutSec: { def: 900, min: 300, max: 3600, unit: '秒', group: 'advanced' },
  ffmpegTimeoutSec: { def: 300, min: 60, max: 1800, unit: '秒', group: 'advanced' },
  cmdTimeoutSec: { def: 180, min: 60, max: 900, unit: '秒', group: 'advanced' },
  asrMemMB: { def: 1536, min: 512, max: 16384, unit: 'MB', group: 'advanced' },
  lockTtlMin: { def: 30, min: 5, max: 240, unit: '分钟', group: 'advanced' },
  unitLimit: { def: 5000, min: 1000, max: 20000, unit: '字', group: 'advanced' },
  textLimit: { def: 800, min: 200, max: 5000, unit: '字', group: 'advanced' },
  toolTextCap: { def: 2000, min: 500, max: 12000, unit: '字', group: 'advanced' },
  toolHead: { def: 800, min: 200, max: 5000, unit: '字', group: 'advanced' },
  dmBucketSec: { def: 30, min: 5, max: 120, unit: '秒', group: 'advanced' },
  dmTop: { def: 5, min: 1, max: 20, unit: '桶', group: 'advanced' },
  downloadMaxMB: { def: 512, min: 64, max: 4096, unit: 'MB', group: 'advanced' },
  subRateMin10: { def: 20, min: 5, max: 60, unit: '×10 字/秒', group: 'advanced' },
  subRateMax10: { def: 85, min: 30, max: 200, unit: '×10 字/秒', group: 'advanced' },
  textBrief: { def: 400, min: 100, max: 3000, unit: '字', group: 'advanced' },
}
export const TUNING_KEYS = Object.keys(TUNING_DEFS)

export function tuningDefaults() {
  return Object.fromEntries(TUNING_KEYS.map((key) => [key, TUNING_DEFS[key].def]))
}

export function tuningRanges() {
  return Object.fromEntries(TUNING_KEYS.map((key) => [key, [TUNING_DEFS[key].min, TUNING_DEFS[key].max]]))
}

function clampOne(key, raw) {
  const def = TUNING_DEFS[key]
  const number = Number(raw)
  if (!Number.isFinite(number) || number < def.min || number > def.max) return def.def
  return Math.floor(number)
}

/** 每次调用都读盘：面板改完立即生效，不用重启宿主。 */
export function readTuning() {
  const cfg = depsCfg()
  return Object.fromEntries(TUNING_KEYS.map((key) => [key, clampOne(key, cfg[key])]))
}

/**
 * 写调优参数：`null` = 恢复默认（从文件里删掉该键），越界/非数字忽略。
 * 只认表内键，表外键当作面板的笔误直接丢弃。
 */
export function writeTuning(body) {
  const current = depsCfg()
  let touched = false
  for (const key of TUNING_KEYS) {
    if (!body || !Object.prototype.hasOwnProperty.call(body, key)) continue
    const value = body[key]
    if (value === null) {
      delete current[key]
      touched = true
      continue
    }
    const number = Number(value)
    if (Number.isFinite(number) && number >= TUNING_DEFS[key].min && number <= TUNING_DEFS[key].max) {
      current[key] = Math.floor(number)
      touched = true
    }
  }
  if (!touched) return { ok: true, data: current }
  try {
    writeJsonAtomic(DEPS_CFG, current)
    return { ok: true, data: current }
  } catch (error) {
    return { ok: false, why: describe(error) }
  }
}

// ── deps/cache-config.json ───────────────────────────────────────────────────
export const DEFAULT_CACHE_DAYS = 7
export const DEFAULT_CACHE_MAX_MB = 2048

export function cacheCfg() {
  const raw = readJsonObject(CACHE_CFG, {}, 'cache-config.json')
  return {
    days: Number.isFinite(raw.days) ? Math.max(1, Math.floor(raw.days)) : DEFAULT_CACHE_DAYS,
    maxMb: Number.isFinite(raw.maxMb) ? Math.max(100, Math.floor(raw.maxMb)) : DEFAULT_CACHE_MAX_MB,
  }
}

export function writeCacheCfg(days, maxMb) {
  try {
    writeJsonAtomic(CACHE_CFG, { days, maxMb })
    return { ok: true }
  } catch (error) {
    return { ok: false, why: describe(error) }
  }
}

// ── deps/ui-config.json ──────────────────────────────────────────────────────
export const DEFAULT_UI_CFG = { autoHint: true }

export function uiCfg() {
  return { ...DEFAULT_UI_CFG, ...readJsonObject(UI_CFG, {}, 'ui-config.json') }
}

export function writeUiCfg(patch) {
  const next = { ...uiCfg(), ...patch }
  try {
    writeJsonAtomic(UI_CFG, next)
    return { ok: true, data: next }
  } catch (error) {
    return { ok: false, why: describe(error) }
  }
}

// ── 最近一次调用 ─────────────────────────────────────────────────────────────
export function readLastRun() {
  try {
    const value = JSON.parse(readFileSync(LAST_RUN, 'utf8'))
    return {
      time: value?.time ?? null,
      command: value?.command ?? null,
      ok: typeof value?.ok === 'boolean' ? value.ok : null,
      ms: Number.isFinite(value?.ms) ? value.ms : null,
    }
  } catch {
    return { time: null, command: null, ok: null, ms: null }
  }
}

export function writeLastRun(command, code, ms) {
  try {
    writeJsonAtomic(LAST_RUN, {
      time: new Date().toISOString(),
      command,
      code,
      ok: code === 0,
      ms: Number.isFinite(ms) ? ms : null,
    })
  } catch {}
}

// ── 简单工具 ─────────────────────────────────────────────────────────────────
export function statOrNull(path) {
  try { return statSync(path) } catch { return null }
}

export function exists(path) {
  try { return existsSync(path) } catch { return false }
}
