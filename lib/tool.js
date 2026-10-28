/**
 * 面向模型与斜杠命令的那一层：参数解析、调用、把结果变成模型能读的文本。
 *
 * 两条入口（`/bili` 与 `bili_watch` 工具）共用 `lookup()`，所以参数校验、
 * 失败文案、超长落盘口径不会两边漂移。这也是重构里刻意收掉的一处重复：
 * 原版把同一套逻辑抄了两遍，工具层漏了 `--asr-max`、命令层漏了 `--fast`。
 */
import { LOOK, recordRun, runLook, trimForModel } from './look.js'
import { buildVisual } from './visual.js'
import { readTuning, tuningDefaults, tuningRanges } from './config.js'

export const COMMANDS = ['search', 'hot', 'peek', 'view', 'sub', 'comments', 'danmaku', 'asr', 'frames', 'sheet', 'substrip', 'ocr', 'text', 'visual', 'login', 'clean']

const KNOWN_FLAGS = [
  '--step', '--p', '--cred', '--days', '--limit', '--order', '--grid', '--out', '--ffmpeg',
  '--head', '--full', '--verify', '--format', '--fresh', '--ocr', '--poll', '--check',
  '--fast', '--scene', '--mark-seen', '--asr-max', '--extra-frames', '--transcript',
]

const VALUE_FLAGS = new Set(['--step', '--p', '--cred', '--days', '--limit', '--order', '--grid', '--out', '--ffmpeg', '--head', '--format', '--asr-max', '--extra-frames', '--transcript'])
const SWITCH_FLAGS = new Set(['--full', '--verify', '--fresh', '--ocr', '--poll', '--check', '--fast', '--scene', '--mark-seen'])

/** 路径闸：--out 只许工作区内的相对路径（绝对路径、盘符、~、.. 一律拒）。 */
function badOutPath(value) {
  return /^([/\\]|[A-Za-z]:|~)|\.\./.test(String(value || ''))
}

/** 把 "text BV1xx --step 2" 拆成结构；未知 flag 收集起来给拼写提示。 */
export function parseCommandLine(raw) {
  const tokens = String(raw ?? '').trim().split(/\s+/).filter(Boolean)
  const command = tokens.shift()
  const positionals = []
  const extra = []
  const unknownFlags = []
  let badOut = false
  while (tokens.length) {
    let token = tokens.shift()
    if (token.startsWith('--') && token.includes('=')) {
      const at = token.indexOf('=')
      tokens.unshift(token.slice(at + 1))
      token = token.slice(0, at)
    }
    if (VALUE_FLAGS.has(token) && tokens.length) {
      const value = tokens.shift()
      if (token === '--out' && badOutPath(value)) badOut = true
      else extra.push(token, value)
      continue
    }
    if (SWITCH_FLAGS.has(token)) {
      extra.push(token)
      continue
    }
    if (token.startsWith('--')) {
      unknownFlags.push(token)
      continue
    }
    positionals.push(token)
  }
  return { command, bv: positionals[0] || '', positionals, extra, badOut, unknownFlags }
}

function editDistance(left, right) {
  const m = left.length
  const n = right.length
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 0; j <= n; j += 1) dp[0][j] = j
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1))
    }
  }
  return dp[m][n]
}

function suggestFlag(unknown) {
  let best = null
  let bestDistance = Infinity
  for (const candidate of KNOWN_FLAGS) {
    const distance = editDistance(unknown.replace(/^--/, ''), candidate.replace(/^--/, ''))
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  return bestDistance <= 2 ? `未知参数 ${unknown}，你是想用 ${best} 吗` : `未知参数 ${unknown}`
}

/**
 * 跑一次 look.mjs，并把 stdout/stderr 组织成给模型的文本。
 * @returns {Promise<{ok: boolean, text: string}>}
 */
export async function lookup({ command, bv, positionals = [], extra = [], badOut = false, unknownFlags = [], signal = null, timeoutMs }) {
  if (badOut) return { ok: false, text: '--out 只接受工作区内的相对路径（不能用绝对路径、盘符、~ 或 ..）' }
  if (unknownFlags.length) return { ok: false, text: unknownFlags.map(suggestFlag).join('；') }
  if (!command || !COMMANDS.includes(command)) {
    return { ok: false, text: `用法：/bili <${COMMANDS.join('|')}> <BV 或链接> [--step 2] [--format srt|json|md|txt]` }
  }
  if (!['clean', 'login', 'hot', 'search'].includes(command) && !bv) {
    return { ok: false, text: `缺少 BV 号或链接，用法：/bili ${command} <BV>` }
  }
  const args = command === 'clean'
    ? ['clean']
    : command === 'login' || command === 'hot'
      ? [command, ...extra]
      : command === 'comments' && String(positionals[1] || '').trim()
        ? [command, bv, String(positionals[1]).trim(), ...extra]
        : [command, bv, ...extra]

  const result = await runLook(args, { signal, ...(timeoutMs ? { timeoutMs } : {}) })
  if (command !== 'login') {
    const stub = ['clean', 'login', 'hot'].includes(command) ? '' : String(bv || '')
    recordRun({ command, bv: stub, argv: args, code: result.code, signal: null, ms: result.ms, stderr: result.err })
  }
  return { ok: result.code === 0, text: composeResult({ ...result, command }) }
}

/** 失败先给 stderr（诊断），成功先给 stdout；⚠ 行拼成一句「警告」。 */
function composeResult({ command, code, out, err }) {
  const failed = code !== 0
  const stdout = String(out || '').trim()
  const stderr = String(err || '').trim()
  const parts = []
  if (failed) parts.push(`（${command} 失败，退出码 ${code ?? '?'}）`)
  const written = !failed ? stderr.match(/✓\s*已写入\s*(.+)/) : null
  if (failed ? stderr : stdout) parts.push(failed ? stderr : stdout)
  if (failed && stdout) parts.push(stdout)
  if (!parts.length) {
    if (!failed && written) parts.push(`结果已写入 ${written[1].trim()}`)
    else if (failed) parts.push(`（${command} 没有输出，退出码 ${code ?? '?'}；完整日志见视频缓存目录下的 last-error.json）`)
    else parts.push(`（${command} 没有输出，退出码 ${code ?? '?'}）`)
  }
  const warnings = !failed && stderr
    ? stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.includes('⚠'))
    : []
  if (warnings.length) parts.push(`警告：${warnings.join('；')}`)
  return parts.join('\n')
}

/** 工具参数 → 命令行参数。表外字段忽略，`--out` 走同一套路径闸。 */
function toolArgsToExtra(args) {
  const extra = ['--quiet']
  if (Number.isInteger(args.p) && args.p > 0) extra.push('--p', String(args.p))
  if (Number.isFinite(args.step) && args.step > 0) extra.push('--step', String(Math.floor(args.step)))
  if (args.ocr) extra.push('--ocr')
  if (args.fast) extra.push('--fast')
  if (args.scene) extra.push('--scene')
  if (typeof args.grid === 'string' && args.grid.trim()) extra.push('--grid', args.grid.trim())
  if (Number.isFinite(args.days) && args.days > 0) extra.push('--days', String(Math.floor(args.days)))
  if (Number.isFinite(args.limit) && args.limit > 0) extra.push('--limit', String(Math.floor(args.limit)))
  if (typeof args.format === 'string' && args.format.trim()) extra.push('--format', args.format.trim())
  if (Number.isFinite(args.head) && args.head > 0) extra.push('--head', String(Math.floor(args.head)))
  if (args.full) extra.push('--full')
  if (args.verify) extra.push('--verify')
  if (args.fresh) extra.push('--fresh')
  return extra
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: '是否成功' },
    text: { type: 'string', description: '给模型读的正文（失败时是错误信息）' },
    images: {
      type: 'array',
      description: 'visual 命令附带的图片附件（其它命令为空）',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          attachmentId: { type: 'string' },
          mediaType: { type: 'string' },
          bytes: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          name: { type: 'string' },
        },
      },
    },
  },
  required: ['ok', 'text'],
}

function renderToolResult(args, value) {
  const text = String(value?.text ?? '')
  const head = value?.ok === false ? '⚠ 本次调用失败（ok=false），下面是错误信息，不是视频内容。\n' : ''
  let body
  if (args?.full || text.length <= 2500) {
    body = head + text
  } else {
    const points = Array.from(text)
    body = `${head}${points.slice(0, 2000).join('')}\n…（已截断，全文见上面提示里的路径）…\n${points.slice(-400).join('')}`
  }
  const blocks = [{ type: 'text', text: body }]
  // visual：把宿主已经存好的图片附件直接放进结果，模型一次就能「看图 + 读文」。
  for (const ref of Array.isArray(value?.images) ? value.images : []) {
    if (ref && typeof ref.attachmentId === 'string') blocks.push({ type: 'image', attachment: ref })
  }
  return blocks
}

/** bili_watch 工具定义（registry 直收的 JSON Schema 形态，不依赖 dsh-tools）。 */
export function createToolDefinition({ ctx } = {}) {
  return {
    name: 'bili_watch',
    description: [
      '读取一个 B 站视频的内容材料（只读、匿名），把视频变成可引用的文字或图片。',
      '优先级：AI 字幕 → 本地 ASR 转写 → 抽帧 OCR → 读帧。',
      '用户给出 B 站链接 / BV 号，要我看、总结、判断讲了什么、值不值得看时使用。',
      'command=text 会按优先级自动降级并返回最可信的一份文本（推荐）；',
      'command=visual 一次返回「字幕文本 + 九宫格画面」（图片直接随结果给出，不用再 read_image），需要看画面/多模态判断时用它；',
      'view=标题/简介/热评；comments=评论区；danmaku=弹幕热区；sub=只要字幕；asr=强制本地转写；',
      'frames=抽帧（ocr=true 顺带识别画面文字）；ocr=抽帧并识别；sheet=N 帧拼图（省 token）；substrip=底部字幕竖拼；',
      'peek=先看是什么类型的视频（需下载 360p，约每分钟 1 MB）；search=按关键词搜；hot=综合热门。',
      '多 P 视频用 p 指定分 P（默认 P1）。拿到材料后由你负责理解与总结。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: {
          type: 'string',
          enum: ['search', 'hot', 'peek', 'view', 'sub', 'comments', 'danmaku', 'asr', 'frames', 'sheet', 'substrip', 'ocr', 'text', 'visual'],
          description: '要看哪一类材料。想要「讲了什么」用 text；要「画面 + 文本」一次拿到用 visual；想先看有什么可看的用 search/hot。',
        },
        keyword: { type: 'string', description: 'command=search 的关键词，如「DeepSeek」。' },
        bv: { type: 'string', description: 'BV 号（如 BV1xx411c7mD），或直接贴 B 站分享链接，会自动提取 BV。search/hot 不需要。' },
        days: { type: 'number', description: 'command=search 只保留最近 N 天发布的。' },
        p: { type: 'number', description: '多 P 视频的分 P 序号（1 起），默认 P1。' },
        step: { type: 'number', description: '抽帧间隔秒数；不传按视频时长自适应。' },
        ocr: { type: 'boolean', description: 'command=frames 时是否顺带识别画面文字。' },
        fast: { type: 'boolean', description: 'command=text 跳过本地转写，字幕拿不到就直接抽帧 OCR。' },
        scene: { type: 'boolean', description: 'command=frames 按画面变化点抽帧。' },
        grid: { type: 'string', description: 'command=sheet/visual 的格子，如 3x3（默认 3x3）。' },
        extraFrames: { type: 'number', description: 'command=visual 时额外附带的单帧数量（0–3，默认 0）。每多一张就多一份视觉 token。' },
        transcript: { type: 'string', enum: ['auto', 'full', 'off'], description: 'command=visual 的文本口径：auto=只试官方字幕（快，默认）；full=没有字幕时再跑本地转写/OCR（慢）；off=只要画面与元数据。' },
        format: { type: 'string', description: 'sub 可选 srt/json/md/txt；text 可选 json/md；comments/danmaku 可选 json。' },
        out: { type: 'string', description: '传了 format 时把结果写到这个文件（只接受工作区内相对路径）。' },
        head: { type: 'number', description: '只取前 N 字。' },
        full: { type: 'boolean', description: '返回全文。长视频可能几万字，只在你确实需要全文时用。' },
        verify: { type: 'boolean', description: 'command=text 时抽首尾帧 OCR 交叉核对字幕是否与画面相符。' },
        fresh: { type: 'boolean', description: '忽略缓存，强制重新下载/抽帧。' },
        limit: { type: 'number', description: 'command=hot/search 的结果条数。' },
      },
      required: ['command'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderToolResult },
    timeoutMs: 1_200_000,
    isConcurrencySafe: () => true,
    execute: async (args, execCtx) => {
      const signal = execCtx?.signal || null
      const extra = toolArgsToExtra(args || {})
      if (typeof args?.out === 'string' && args.out.trim()) {
        const out = args.out.trim()
        if (badOutPath(out)) return { ok: false, text: '--out 只接受工作区内的相对路径（不能用绝对路径、盘符、~ 或 ..）' }
        extra.push('--out', out)
      }
      try {
        // visual：宿主自己拼「文本 + 图片附件」，不走 look.mjs 的单命令输出。
        if (args.command === 'visual') {
          const target = String(args.bv ?? '').trim()
          if (!target) return { ok: false, text: 'visual 需要 bv（BV 号或分享链接）', images: [] }
          const visual = await buildVisual(ctx, {
            bv: target,
            grid: args.grid,
            step: args.step,
            extraFrames: args.extraFrames,
            transcript: args.transcript,
            page: args.p,
            signal,
          })
          // 工具值按 output.schema 校验（additionalProperties:false），只回声明过的字段。
          return { ok: visual.ok, text: visual.text, images: visual.images }
        }
        if (args.command === 'hot') {
          const result = await lookup({ command: 'hot', bv: '', extra, signal })
          return { ok: result.ok, text: trimForModel(result.text, 'hot', '_hot') }
        }
        const target = args.command === 'search' ? String(args.keyword ?? '').trim() : String(args.bv ?? '').trim()
        if (args.command === 'search' && !target) return { ok: false, text: 'search 需要 keyword 参数（要搜什么词）' }
        if (!target) return { ok: false, text: '缺少 BV 号或分享链接' }
        const result = await lookup({ command: args.command, bv: target, extra, signal })
        return { ok: result.ok, text: trimForModel(result.text, args.command, target, { full: args.full, head: args.head }) }
      } catch (error) {
        return {
          ok: false,
          text: `工具执行异常：${String(error?.message || error)}；可以先用 fast 或换一个 BV 再试`,
          images: [],
        }
      }
    },
  }
}

/** 面板「参数」页展示用：把当前值、默认值、范围一次交给前端。 */
export function tuningSchema() {
  return {
    values: readTuning(),
    defaults: tuningDefaults(),
    ranges: tuningRanges(),
  }
}

export { LOOK }
