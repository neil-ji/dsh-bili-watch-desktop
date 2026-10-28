/**
 * 抽帧缓存：定位、统计、清理。
 *
 * 关键原则（沿用原版，并在重构里补了两处）：
 *   ① 只删「自己建的东西」——BV* 目录、白名单子目录、以及只含本插件产物的目录；
 *      根下别人的文件一个都不碰；
 *   ② 有正在跑的任务（.lock 且进程活着、没超时）时不清理，避免删掉正在写的产物；
 *   ③ 重构补丁：进度统计不再阻塞事件循环（目录体积单独缓存），
 *      读取状态（/status）不再顺手清盘——清盘只在启动、面板点「清理」、以及后台定时器里发生。
 */
import { existsSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  CACHE_MARK, DEFAULT_CACHE_DAYS, DEFAULT_CACHE_MAX_MB, DEFAULT_CACHE_DIR, OWN_CACHE_DIRS,
  addWarning, cacheCfg, depsCfg, ensureDir, readTuning,
} from './config.js'

let cached = { at: 0, dir: '', fallback: null }
let lastCleanAt = 0
const sizeCache = new Map()

/** 缓存根：env BILI_WATCH_CACHE > deps-config.cache > $DSH_HOME/bili-watch/cache。 */
export function cacheDir() {
  const now = Date.now()
  if (cached.dir && now - cached.at < 5000) return cached
  const wanted = process.env.BILI_WATCH_CACHE || depsCfg().cache
  const target = wanted ? String(wanted) : DEFAULT_CACHE_DIR
  // 用户指定了外部目录、且它还不是本插件的缓存根时，拼一个专属子目录，
  // 绝不把用户自己的目录直接当缓存根（否则清理会在用户目录里找我们的目录名）。
  const dir = wanted && !hasBvLayout(target) ? join(target, 'bili-watch-cache') : target
  let fallback = null
  try {
    ensureDir(dir)
    const mark = join(dir, CACHE_MARK)
    if (!existsSync(mark)) {
      writeFileSync(mark, JSON.stringify({ version: 1, createdAt: new Date().toISOString() }), 'utf8')
    }
  } catch (error) {
    fallback = String(error?.message || error)
    try { ensureDir(DEFAULT_CACHE_DIR) } catch {}
    cached = { at: now, dir: DEFAULT_CACHE_DIR, fallback }
    addWarning(`缓存目录不可用，已回退到 ${DEFAULT_CACHE_DIR}：${fallback}`)
    return cached
  }
  cached = { at: now, dir, fallback: null }
  return cached
}

/** 这个目录是否已经是「本插件的缓存根」。 */
export function hasBvLayout(dir) {
  try { if (existsSync(join(dir, CACHE_MARK))) return true } catch {}
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (!/^BV[0-9A-Za-z]{10}/i.test(entry.name)) continue
      try { if (existsSync(join(dir, entry.name, 'meta.json'))) return true } catch {}
    }
  } catch {}
  return false
}

/** 某个路径是不是本插件名下的条目（相对缓存根的第一段判断）。 */
export function isOwnedEntry(dir, path) {
  const first = relative(dir, path).split(/[\\/]/)[0]
  if (/^BV[0-9A-Za-z]{10}/i.test(first)) return true
  if (OWN_CACHE_DIRS.has(first)) return true
  if (/^\.(meta-|write-test-)/.test(first)) return true
  return false
}

/**
 * 目录里只有本插件产物才认领：至少一个 `*.tool.txt`，或名字本身像 URL
 * （短链没解析成 BV 时，插件会建成 `https...` 形态的目录）。
 */
function looksLikeOwnDir(path, name) {
  let entries
  try { entries = readdirSync(path, { withFileTypes: true }) } catch { return false }
  if (!entries.length) return /^https?/i.test(name)
  let hasToolTxt = false
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!OWN_CACHE_DIRS.has(entry.name)) return false
      continue
    }
    if (/\.tool\.txt$/i.test(entry.name)) hasToolTxt = true
    else if (!/^(meta\.json|.*\.lock)$/i.test(entry.name)) return false
  }
  return hasToolTxt || /^https?/i.test(name)
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

function readLock(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (Number.isInteger(value?.pid) && value.pid > 0) return value
  } catch {}
  return null
}

function lockExpired(owner) {
  if (!owner) return true
  const ttl = (owner.ttlMs || readTuning().lockTtlMin * 60_000)
  return Date.now() - (owner.at || 0) > ttl
}

/** 缓存里是否还有活着的任务锁（递归深度 ≤3，覆盖 frames/asr/sheet-tmp 等）。 */
export function hasAnyLock(root) {
  const walk = (dir, depth) => {
    if (depth > 3) return false
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return false }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.lock')) {
        const owner = readLock(join(dir, entry.name))
        if (owner && pidAlive(owner.pid) && !lockExpired(owner)) return true
        continue
      }
      if (entry.isDirectory() && walk(join(dir, entry.name), depth + 1)) return true
    }
    return false
  }
  return walk(root, 0)
}

/** 缓存体积：`_logs` 与根标记不算占用（它们不是「立即清理能清掉的量」）。 */
export function dirStat(dir, { useCache = true } = {}) {
  const key = String(dir)
  const now = Date.now()
  const hit = sizeCache.get(key)
  if (useCache && hit && now - hit.at < 30_000) return hit.value
  let bytes = 0
  let files = 0
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === CACHE_MARK || entry.name === '_logs') continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else {
        files += 1
        try { bytes += statSync(path).size } catch {}
      }
    }
  }
  try { walk(dir) } catch {}
  const value = { bytes, files }
  sizeCache.set(key, { at: now, value })
  return value
}

function walkEntries(dir) {
  const out = []
  const walk = (current) => {
    let list
    try { list = readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of list) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        if (isOwnedEntry(dir, path)) walk(path)
        continue
      }
      if (!isOwnedEntry(dir, path)) continue
      try {
        const stat = statSync(path)
        out.push({ path, size: stat.size, mtime: stat.mtimeMs })
      } catch {}
    }
  }
  walk(dir)
  return out
}

/** 删掉本插件名下的条目；别人的东西进 skipped，删失败的进 failed。 */
export function removeOwned(dir) {
  let files = 0
  let bytes = 0
  const skipped = []
  const failed = []
  let list = []
  try { list = readdirSync(dir, { withFileTypes: true }) } catch { return { files, bytes, skipped, failed } }
  for (const entry of list) {
    const path = join(dir, entry.name)
    if (entry.isDirectory() && (/^BV[0-9A-Za-z]{10}/i.test(entry.name) || OWN_CACHE_DIRS.has(entry.name) || looksLikeOwnDir(path, entry.name))) {
      const stat = dirStat(path, { useCache: false })
      try {
        rmSync(path, { recursive: true, force: true, maxRetries: 3 })
        files += stat.files
        bytes += stat.bytes
      } catch (error) {
        failed.push({ name: entry.name, why: String(error?.message || error) })
      }
    } else if (entry.isFile() && /^\.(meta-|write-test-)/.test(entry.name)) {
      try {
        const stat = statSync(path)
        rmSync(path, { force: true })
        files += 1
        bytes += stat.size
      } catch (error) {
        failed.push({ name: entry.name, why: String(error?.message || error) })
      }
    } else if (entry.isFile() && entry.name === CACHE_MARK) {
      // 缓存根标记：静默保留
    } else {
      skipped.push({ name: entry.name, why: '不是 bili-watch 的缓存条目' })
    }
  }
  sizeCache.delete(String(dir))
  return { files, bytes, skipped, failed }
}

/** 删完文件留一堆空目录，这里自底向上清白名单内的空目录。 */
export function pruneEmptyDirs(root) {
  const dirs = []
  const collect = (dir) => {
    let list
    try { list = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of list) {
      if (!entry.isDirectory()) continue
      const path = join(dir, entry.name)
      if (!isOwnedEntry(root, path)) continue
      collect(path)
      dirs.push(path)
    }
  }
  collect(root)
  for (const dir of dirs.reverse()) {
    try { rmdirSync(dir) } catch {}
  }
}

/**
 * 自动清理：先按天数，再按总量从最旧删到阈值内。
 * 每 10 分钟最多跑一次（`force` 跳过节流），有任务锁时整体跳过。
 */
export function autoCleanCache({ force = false } = {}) {
  if (!force && Date.now() - lastCleanAt < 10 * 60_000) return { removed: 0, bytes: 0, skipped: true }
  const { dir } = cacheDir()
  if (!existsSync(dir)) return { removed: 0, bytes: 0 }
  if (hasAnyLock(dir)) return { removed: 0, bytes: 0, skipped: true, locked: true }
  const cfg = cacheCfg()
  const days = cfg.days || DEFAULT_CACHE_DAYS
  const maxMb = cfg.maxMb || DEFAULT_CACHE_MAX_MB
  const cutoff = Date.now() - days * 86_400_000
  const limit = maxMb * 1024 * 1024
  const entries = walkEntries(dir)
  let removed = 0
  let bytes = 0
  const fresh = []
  for (const entry of entries) {
    if (entry.mtime < cutoff) {
      try {
        rmSync(entry.path, { force: true })
        removed += 1
        bytes += entry.size
      } catch {}
    } else {
      fresh.push(entry)
    }
  }
  let total = fresh.reduce((sum, entry) => sum + entry.size, 0)
  if (total > limit) {
    fresh.sort((left, right) => left.mtime - right.mtime)
    for (const entry of fresh) {
      try {
        rmSync(entry.path, { force: true })
        removed += 1
        bytes += entry.size
        total -= entry.size
      } catch {}
      if (total <= limit) break
    }
  }
  if (removed) {
    pruneEmptyDirs(dir)
    sizeCache.delete(String(dir))
  }
  lastCleanAt = Date.now()
  return { removed, bytes, at: lastCleanAt }
}

/** 面板上「当前占用」用：体积 + 规则 + 位置。 */
export function cacheSnapshot() {
  const { dir, fallback } = cacheDir()
  const stat = dirStat(dir)
  return {
    dir,
    fallback,
    bytes: stat.bytes,
    files: stat.files,
    ...cacheCfg(),
  }
}
