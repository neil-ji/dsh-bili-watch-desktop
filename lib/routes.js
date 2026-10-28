/**
 * 面板用的 HTTP 端点（/api/bili-watch/*）。
 *
 * 为什么还要 HTTP：DSH 的插件面板运行在宿主页面里，桌面壳没有给第三方插件
 * 一条现成的「客户端 → 宿主」RPC（`host.call` 只对动态 Package 开放）。
 * 所以这里保留一条最小 API，但把授权收成两层：
 *
 *   ① 首选「页面令牌」：宿主渲染 index.html 时注入 `window.__DSH_BILI_TOKEN__`，
 *      面板把它放进 `x-bili-token` 头。令牌是每个宿主进程随机生成的 32 字节，
 *      只有真正打开过本机页面的人才拿得到（未授权的 GET / 会被网关挡成 401）。
 *   ② 兼容旧通道：没有令牌时退回「回环 + Host 回环 + 同源」判据，
 *      与原版一致（桌面壳的同源 fetch 不带 Origin，所以 Origin 只在存在时才校验）。
 *
 * 与 Dot 版相比的另一处收紧：所有写操作都要求令牌或同源 JSON，
 * 且 `--out`、删除目标、下载目标都在这里过白名单；GET 不再产生任何磁盘副作用。
 */
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { autoCleanCache, cacheDir, cacheSnapshot, hasAnyLock, removeOwned } from './cache.js'
import {
  DEPS, HERE, RUN_DIR, addWarning, cacheCfg, readTuning, uiCfg,
  warningsSnapshot, writeCacheCfg, writeDepsCfg, writeTuning, writeUiCfg,
} from './config.js'
import { credState, createLoginQr, pollLogin } from './cred.js'
import { clearStaleRunning, deleteDeps, depRows, downloadState, probeFfmpeg, startDownload } from './deps.js'
import { LOOK, recentRuns, recordRun } from './look.js'
import { tuningSchema } from './tool.js'

const API_PREFIX = '/api/bili-watch'
const MAX_BODY = 64 * 1024
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** 从 Host 头取主机名："example.com:3080" / "[::1]:3080"。 */
function hostNameOf(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return ''
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']')
    return close >= 0 ? raw.slice(0, close + 1) : raw
  }
  const colon = raw.lastIndexOf(':')
  return colon >= 0 && /^\d+$/.test(raw.slice(colon + 1)) ? raw.slice(0, colon) : raw
}

function isLoopbackPeer(req) {
  const peer = String(req.socket?.remoteAddress || '')
  return !peer || /^(::1|::ffff:127\.|127\.)/.test(peer)
}

/**
 * 授权判定。返回 null 表示放行，否则返回一句给用户看的原因。
 * 令牌优先：有正确令牌的请求不看 Origin/Host（它已经证明自己来自本机页面）。
 */
function authorize(req, token) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const supplied = req.headers?.['x-bili-token'] || url.searchParams.get('t')
  if (typeof supplied === 'string' && supplied && token && supplied.length === token.length) {
    // 常量时间比较，避免用响应时间逐字节猜令牌
    let diff = 0
    for (let i = 0; i < token.length; i += 1) diff |= supplied.charCodeAt(i) ^ token.charCodeAt(i)
    if (diff === 0) return null
  }
  if (!isLoopbackPeer(req)) return `非本机请求被拒绝（对端 ${req.socket?.remoteAddress}）`
  const host = hostNameOf(req.headers?.host)
  if (!LOOPBACK.has(host)) return '非本机请求被拒绝（Host 必须是回环地址）'
  const origin = req.headers?.origin
  if (origin) {
    let originHost = ''
    try { originHost = new URL(origin).hostname } catch { return '非法 Origin 头' }
    if (originHost !== host && !(LOOPBACK.has(host) && LOOPBACK.has(originHost))) return '跨源访问被拒绝'
  }
  const method = String(req.method || 'GET').toUpperCase()
  const mutating = method !== 'GET' && method !== 'HEAD'
  const site = req.headers?.['sec-fetch-site']
  if (mutating) {
    const contentType = String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (contentType !== 'application/json') return '写请求必须是 application/json'
  }
  if (site && site !== 'same-origin' && site !== 'none') return `跨站请求被拒绝（sec-fetch-site=${site}）`
  return null
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > MAX_BODY) {
        req.destroy()
        resolve(null)
      }
    })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(raw || '{}')
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null)
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function statusPayload() {
  clearStaleRunning()
  return {
    ok: true,
    data: {
      version: readVersion(),
      platform: process.platform,
      paths: { deps: DEPS, cache: cacheDir().dir, credential: credState().path, runtime: RUN_DIR },
      credential: credState(),
      deps: depRows(),
      cache: cacheSnapshot(),
      tuning: tuningSchema(),
      ui: uiCfg(),
      lastRun: recentRuns(1)[0] || null,
      runs: recentRuns(5),
      downloads: downloadState(),
      warnings: warningsSnapshot(),
      hasLook: Boolean(LOOK),
    },
  }
}

function readVersion() {
  try {
    return JSON.parse(readFileSync(`${HERE}/package.json`, 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** 缓存目录只接受绝对路径；相对路径（含 `~`）一律拒，避免把缓存指到进程 cwd 里。 */
function parseCachePath(value) {
  const raw = String(value ?? '').trim()
  if (!raw || raw.includes('\0')) return null
  if (raw.startsWith('~')) return null
  return isAbsolute(raw) ? raw : null
}

/**
 * 挂载全部端点。返回 disposer（ctx.effect 负责调用）。
 * @param {any} ctx - 宿主插件上下文。
 * @param {string} token - 每进程随机令牌。
 */
export function mountRoutes(ctx, token) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const blocked = authorize(req, token)
      if (blocked) return sendJson(res, 403, { ok: false, why: blocked })
      const url = new URL(req.url, 'http://127.0.0.1')
      const route = url.pathname.slice(API_PREFIX.length) || '/'
      const method = String(req.method || 'GET').toUpperCase()
      try {
        if (method === 'GET' && route === '/status') return sendJson(res, 200, statusPayload())
        if (method === 'GET' && route === '/runs') return sendJson(res, 200, { ok: true, data: recentRuns(20) })

        if (method === 'POST' && route === '/config') {
          const body = await readJsonBody(req)
          if (!body) return sendJson(res, 400, { ok: false, why: '请求体必须是 JSON 对象' })
          const problems = []
          let changed = false

          if (body.tuning && typeof body.tuning === 'object') {
            const written = writeTuning(body.tuning)
            if (!written.ok) problems.push(`参数保存失败：${written.why}`)
            else changed = true
          }
          if (typeof body.autoHint === 'boolean') {
            const written = writeUiCfg({ autoHint: body.autoHint })
            if (!written.ok) problems.push(`界面设置保存失败：${written.why}`)
            else changed = true
          }
          if (Number.isFinite(body.days) || Number.isFinite(body.maxMb)) {
            const current = cacheCfg()
            const days = Number.isFinite(body.days) ? Math.max(1, Math.floor(body.days)) : current.days
            const maxMb = Number.isFinite(body.maxMb) ? Math.max(100, Math.floor(body.maxMb)) : current.maxMb
            const written = writeCacheCfg(days, maxMb)
            if (!written.ok) problems.push(`清理规则保存失败：${written.why}`)
            else changed = true
          }
          if (!changed && !problems.length) problems.push('没有可写入的字段')
          if (problems.length) return sendJson(res, 400, { ok: false, why: problems.join('；') })
          return sendJson(res, 200, { ok: true, data: { tuning: readTuning(), ui: uiCfg(), cache: cacheCfg() } })
        }

        if (method === 'POST' && route === '/cache/clear') {
          const dir = cacheDir().dir
          if (hasAnyLock(dir)) {
            return sendJson(res, 409, { ok: false, why: '有任务正在写缓存（检测到运行中的锁），等它跑完再清' })
          }
          const removed = removeOwned(dir)
          return sendJson(res, 200, {
            ok: removed.failed.length === 0,
            why: removed.failed.length ? `部分失败：${removed.failed.length} 项` : undefined,
            data: { removed: removed.files, files: removed.files, bytes: removed.bytes, skipped: removed.skipped, failed: removed.failed },
          })
        }

        if (method === 'POST' && route === '/cache/location') {
          const body = await readJsonBody(req)
          if (!body) return sendJson(res, 400, { ok: false, why: '请求体必须是 JSON 对象' })
          const dir = parseCachePath(body.dir)
          if (!dir) return sendJson(res, 400, { ok: false, why: '目录路径不合法（需要绝对路径）' })
          const written = writeDepsCfg({ cache: dir })
          if (!written.ok) return sendJson(res, 500, { ok: false, why: `保存失败：${written.why}` })
          return sendJson(res, 200, { ok: true, data: { dir, restart: true } })
        }

        if (method === 'POST' && route === '/download') {
          const body = await readJsonBody(req)
          if (!body) return sendJson(res, 400, { ok: false, why: '请求体必须是 JSON 对象' })
          const targets = Array.isArray(body.targets) ? body.targets.slice(0, 8) : [body.target]
          const result = startDownload(targets, { mirror: body.mirror === 'cn' ? 'cn' : '' })
          return sendJson(res, result.started.length ? 200 : 400, {
            ok: result.started.length > 0,
            why: result.rejected.map((item) => `${item.target}：${item.why}`).join('；') || undefined,
            data: result,
          })
        }

        if (method === 'POST' && route === '/delete') {
          const body = await readJsonBody(req)
          if (!body) return sendJson(res, 400, { ok: false, why: '请求体必须是 JSON 对象' })
          const targets = Array.isArray(body.targets) ? body.targets.slice(0, 8) : [body.target]
          return sendJson(res, 200, { ok: true, data: deleteDeps(targets) })
        }

        if (method === 'POST' && route === '/login/qr') {
          const result = await createLoginQr()
          return sendJson(res, result.ok ? 200 : 502, result)
        }

        if (method === 'POST' && route === '/login/poll') {
          const body = await readJsonBody(req)
          if (!body) return sendJson(res, 400, { ok: false, why: '请求体必须是 JSON 对象' })
          const result = await pollLogin(body.key)
          if (result.state === 'ok') recordRun({ command: 'login', bv: '', argv: ['login'], code: 0, ms: 0 })
          return sendJson(res, 200, result)
        }

        if (method === 'POST' && route === '/probe') {
          const result = await probeFfmpeg()
          return sendJson(res, 200, { ok: true, data: result })
        }

        if (method === 'POST' && route === '/cleanup') {
          const cleaned = autoCleanCache({ force: true })
          return sendJson(res, 200, { ok: true, data: cleaned })
        }

        return sendJson(res, 404, { ok: false, why: `未知端点 ${method} ${API_PREFIX}${route}` })
      } catch (error) {
        addWarning(`面板请求失败：${String(error?.message || error)}`)
        return sendJson(res, 500, { ok: false, why: String(error?.message || error) })
      }
    },
  })
}
