/**
 * B 站登录：扫码、轮询、凭证落盘。
 *
 * 只跟 passport.bilibili.com / api.bilibili.com 打交道，扫码得到的 cookie
 * 写进 `$DSH_HOME/bili-watch/credential.json`（0o600；Windows 上 mode 不生效，
 * 见 README 的说明），CLI 与宿主读同一份，不再跨产品共享 bili-duty 的登录态。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import QRCode from 'qrcode'
import { CRED_FILE, RUN_DIR, addWarning } from './config.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const QR_GENERATE = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header'
const QR_POLL = (key) => `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`
const FINGER_SPI = 'https://api.bilibili.com/x/frontend/finger/spi'
const REQUIRED_FIELDS = ['sessdata', 'bili_jct', 'buvid3', 'buvid4']

/** 扫码状态文案由前端映射，这里只回状态码。 */
const POLL_STATES = { 86101: 'waiting', 86090: 'scanned', 86038: 'expired' }

function ageDaysOf(iso) {
  const time = Date.parse(String(iso || ''))
  if (!Number.isFinite(time)) return null
  return Math.max(0, Math.floor((Date.now() - time) / 86_400_000))
}

/** 凭证现状：missing / incomplete / expired / ok / unknown。 */
export function credState() {
  if (!existsSync(CRED_FILE)) return { exists: false, state: 'missing', updatedAt: null, ageDays: null, path: CRED_FILE }
  try {
    const value = JSON.parse(readFileSync(CRED_FILE, 'utf8'))
    const updatedAt = value?.updatedAt || statSync(CRED_FILE).mtime.toISOString()
    const ageDays = ageDaysOf(updatedAt)
    const missing = REQUIRED_FIELDS.filter((field) => !value?.[field])
    if (missing.length) return { exists: true, state: 'incomplete', missing, updatedAt, ageDays, path: CRED_FILE }
    return { exists: true, state: ageDays !== null && ageDays > 30 ? 'expired' : 'ok', updatedAt, ageDays, path: CRED_FILE }
  } catch (error) {
    addWarning(`凭证文件读取失败：${String(error?.message || error)}`)
    return { exists: true, state: 'unknown', updatedAt: null, ageDays: null, path: CRED_FILE }
  }
}

export function readCredential() {
  try { return JSON.parse(readFileSync(CRED_FILE, 'utf8')) } catch { return null }
}

export function deleteCredential() {
  if (!existsSync(CRED_FILE)) return { ok: true, removed: false }
  try {
    rmSync(CRED_FILE, { force: true })
    return { ok: true, removed: true }
  } catch (error) {
    return { ok: false, why: String(error?.message || error) }
  }
}

function writeCredential(jar) {
  mkdirSync(dirname(CRED_FILE), { recursive: true })
  writeFileSync(CRED_FILE, JSON.stringify({
    sessdata: jar.sessdata,
    bili_jct: jar.bili_jct || '',
    buvid3: jar.buvid3 || '',
    buvid4: jar.buvid4 || '',
    mid: jar.dedeuserid || '',
    note: 'B 站扫码登录（dsh-bili-watch 桌面面板）',
    updatedAt: new Date().toISOString(),
  }, null, 2), { encoding: 'utf8', mode: 0o600 })
  return { path: CRED_FILE, dir: RUN_DIR }
}

function pickCookies(list) {
  const jar = {}
  const wanted = { SESSDATA: 'sessdata', bili_jct: 'bili_jct', DedeUserID: 'dedeuserid', buvid3: 'buvid3', buvid4: 'buvid4' }
  for (const raw of list || []) {
    const first = String(raw).split(';')[0] || ''
    const at = first.indexOf('=')
    if (at <= 0) continue
    const name = first.slice(0, at).trim()
    const value = first.slice(at + 1).trim()
    if (wanted[name] && value) jar[wanted[name]] = value
  }
  return jar
}

async function fillBuvids(jar) {
  if (jar.buvid3 && jar.buvid4) return jar
  try {
    const response = await fetch(FINGER_SPI, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) })
    const body = await response.json()
    if (!jar.buvid3 && body?.data?.b_3) jar.buvid3 = body.data.b_3
    if (!jar.buvid4 && body?.data?.b_4) jar.buvid4 = body.data.b_4
  } catch {}
  return jar
}

/**
 * 生成二维码。返回 PNG data URL 而不是 SVG 字符串：
 * 前端用 <img> 渲染，不需要把任何字符串塞进 innerHTML。
 */
export async function createLoginQr() {
  let body
  try {
    const response = await fetch(QR_GENERATE, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) })
    body = await response.json()
  } catch (error) {
    return { ok: false, why: `请求二维码失败：${String(error?.message || error)}` }
  }
  const data = body?.data
  if (!data?.url || !data?.qrcode_key) return { ok: false, why: body?.message || 'B 站没有返回二维码' }
  try {
    const png = await QRCode.toDataURL(String(data.url), { margin: 1, width: 260, errorCorrectionLevel: 'M' })
    return { ok: true, data: { key: String(data.qrcode_key), image: png } }
  } catch (error) {
    return { ok: false, why: `二维码渲染失败：${String(error?.message || error)}` }
  }
}

/** 轮询一次扫码结果；成功时落盘凭证。 */
export async function pollLogin(key) {
  const clean = String(key || '').trim()
  if (!/^[0-9A-Za-z_-]{8,64}$/.test(clean)) return { ok: false, state: 'error', why: '二维码 key 不合法' }
  let response
  try {
    response = await fetch(QR_POLL(clean), {
      headers: { 'User-Agent': UA },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    return { ok: false, state: 'error', why: `轮询失败：${String(error?.message || error)}` }
  }
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  let body = {}
  try { body = await response.json() } catch {}
  const code = body?.data?.code
  if (code === 0) {
    const jar = await fillBuvids(pickCookies(cookies))
    if (!jar.sessdata) return { ok: false, state: 'error', why: '登录成功，但响应里没有 SESSDATA' }
    try {
      writeCredential(jar)
    } catch (error) {
      return { ok: false, state: 'error', why: `凭证写入失败：${String(error?.message || error)}` }
    }
    return { ok: true, state: 'ok', data: { mid: jar.dedeuserid || '' } }
  }
  return { ok: false, state: POLL_STATES[code] || 'error', why: code === undefined ? (body?.message || 'poll 返回异常') : '' }
}
