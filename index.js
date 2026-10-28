/**
 * dsh-bili-watch（桌面端重构）— 宿主半端。
 *
 * 负责四件事，其余逻辑都在 lib/ 里：
 *   ① /bili 斜杠命令（人敲，确定性执行，不花推理 token）；
 *   ② bili_watch 工具（模型自己调）；
 *   ③ 可选的「只贴了链接」旁白；
 *   ④ 面板用的 /api/bili-watch 端点（带页面令牌）。
 *
 * 与上游 0.3.3 的差异集中在「可靠性」与「桌面端」：
 *   - 不再依赖 @deepseek-ai/dsh-tools / dsh-llm：工具用 registry 直收的 JSON Schema 形态，
 *     两个可选包缺席时不会静默少一个工具；
 *   - 不再往 shell overlay 里塞横幅、不改别的插件的 DOM；
 *   - GET /status 不再顺手清缓存，也不再在轮询里跑同步子进程；
 *   - 端点默认要求每进程随机的页面令牌（局域网/其他本机进程拿不到）。
 */
import { randomBytes } from 'node:crypto'
import { autoCleanCache } from './lib/cache.js'
import { probeFfmpeg } from './lib/deps.js'
import { addWarning, resetWarnings, uiCfg, warningsSnapshot } from './lib/config.js'
import { matchSingleVideoLink, textOfUserMessage } from './lib/hints.js'
import { trimForModel } from './lib/look.js'
import { mountRoutes } from './lib/routes.js'
import { createToolDefinition, lookup, parseCommandLine } from './lib/tool.js'
import { buildVisual } from './lib/visual.js'

export const name = '@local/dsh-bili-watch'
/** 命令与 HTTP 两个服务是硬依赖：没有它们，插件在桌面端没有意义。 */
export const inject = ['commands', 'webServer']

const ROUTE_PATH = '/api/bili-watch'
/** 进程内只有一份路由：fiber 重放/多实例时避免同一路径重复注册。 */
let routeOwner = null

/** 平台/环境摘要，面板用来给「哪些命令现在能用」下判断。 */
function environment() {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    dshHome: process.env.DSH_HOME || '',
  }
}

export function apply(ctx) {
  const token = randomBytes(32).toString('base64url')
  resetWarnings()

  // 启动时按「天数 + 总量」清一次；有任务锁时 autoCleanCache 自己会跳过。
  try {
    const cleaned = autoCleanCache({ force: true })
    if (cleaned.removed) ctx.logger?.info?.(`[bili-watch] 启动清理：${cleaned.removed} 个文件 / ${(cleaned.bytes / 1048576).toFixed(1)} MB`)
  } catch (error) {
    addWarning(`启动清理失败：${String(error?.message || error)}`)
  }

  // ffmpeg 在 PATH 里的情况只在后台探一次（异步，不阻塞宿主，也不进轮询）。
  void probeFfmpeg().catch(() => {})

  // ① 斜杠命令
  ctx.effect(() => ctx.commands.register({
    definitionId: 'dsh-bili-watch',
    name: 'bili',
    description: '看 B 站视频：字幕 → 本地转写 → 抽帧 OCR，输出最可信的一份内容；也支持搜索 / 热榜 / 评论 / 弹幕。',
    input: {
      hint: '<text|visual|view|peek|sub|comments|danmaku|asr|frames|sheet|substrip|ocr|search|hot|login|clean> [BV 或链接] [--p N] [--step 秒] [--grid 3x3] [--extra-frames N] [--format srt|json|md|txt] [--out 相对路径] [--head N] [--full] [--fast] [--verify] [--days N] [--limit N] [--fresh]',
    },
    handler: async (invocation) => {
      const parsed = parseCommandLine(invocation?.rawInput)
      const flagValue = (name) => {
        const at = (parsed.extra || []).indexOf(name)
        return at >= 0 ? parsed.extra[at + 1] : undefined
      }
      // /bili visual：命令通道只能回文本，图片要走 bili_watch 工具（宿主把图存成附件随结果给模型）。
      if (parsed.command === 'visual') {
        const visual = await buildVisual(ctx, {
          bv: parsed.bv,
          grid: flagValue('--grid'),
          step: Number(flagValue('--step')) || 0,
          extraFrames: Number(flagValue('--extra-frames')) || 0,
          transcript: flagValue('--transcript') || 'auto',
          signal: invocation?.signal,
        })
        const note = visual.images?.length
          ? `\n\n（命令通道只回文本；这次已生成 ${visual.images.length} 张图，要让我直接看图请用工具：bili_watch command=visual bv=${parsed.bv}）`
          : ''
        return { kind: visual.ok ? 'success' : 'error', text: trimForModel(`${visual.text}${note}`, 'visual', parsed.bv, {}) }
      }
      const result = await lookup(parsed)
      const full = (parsed.extra || []).includes('--full')
      const headAt = (parsed.extra || []).indexOf('--head')
      const head = headAt >= 0 && Number(parsed.extra[headAt + 1]) ? Number(parsed.extra[headAt + 1]) : null
      return {
        kind: result.ok ? 'success' : 'error',
        text: trimForModel(result.text, parsed.command || 'bili', parsed.bv, { full, head }),
      }
    },
  }), 'bili-watch: /bili 命令')

  // ② 工具（没有 tools 服务的 profile 只少这一个入口）
  const tools = (() => {
    try { return ctx.get?.('tools') } catch { return undefined }
  })()
  if (tools?.register) {
    try {
      ctx.effect(() => tools.register(createToolDefinition({ ctx })), 'bili-watch: bili_watch 工具')
    } catch (error) {
      addWarning(`bili_watch 工具注册失败：${String(error?.message || error)}`)
    }
  } else {
    addWarning('当前 profile 没有 tools 服务，bili_watch 工具未注册（/bili 与面板不受影响）')
  }

  // ③ 「只贴了链接」旁白：默认开，可在面板里关。缺少 dsh-llm 时整段跳过。
  mountHint(ctx)

  // ④ 面板端点
  const webServer = ctx.webServer
  if (!routeOwner) {
    try {
      routeOwner = ctx.effect(() => {
        const dispose = mountRoutes(ctx, token)
        return () => {
          try { dispose?.() } catch {}
          routeOwner = null
        }
      }, `bili-watch: ${ROUTE_PATH} 端点`)
      // 把令牌注入 index.html；页面只在通过网关鉴权后才会拿到它。
      ctx.effect(() => webServer.tapIndex((html) => {
        if (!html.includes('</head>')) return html
        const script = `<script>window.__DSH_BILI_TOKEN__=${JSON.stringify(token)}</script>`
        return html.replace('</head>', `${script}</head>`)
      }), 'bili-watch: 面板令牌')
      ctx.logger?.info?.(`[bili-watch] 面板端点已挂载：${ROUTE_PATH}`)
    } catch (error) {
      routeOwner = null
      addWarning(`面板端点挂载失败：${String(error?.message || error)}`)
      ctx.logger?.warn?.(`[bili-watch] 面板端点挂载失败：${String(error?.message || error)}`)
    }
  }

  ctx.logger?.info?.(`[bili-watch] 已就绪（${environment().platform}/${environment().node}）；告警 ${warningsSnapshot().length} 条`)
}

/**
 * 只贴一条链接时的旁白。它不改用户消息、不调工具，只往下一步的输入里加一句提示。
 * 任何异常都吞掉：旁白失败不该影响这一轮对话。
 */
function mountHint(ctx) {
  let createUserMessage = null
  let boundContextSummary = null
  // 动态 import：dsh-llm 是可选 peer，桌面 profile 里不一定能解析。
  void (async () => {
    try {
      const mod = await import('@deepseek-ai/dsh-llm')
      createUserMessage = mod.createUserMessage ?? null
      boundContextSummary = mod.boundContextSummary ?? null
    } catch {}
    if (!createUserMessage || uiCfg().autoHint === false) return
    const hinted = new Map()
    const hintCap = 500
    let effect
    try {
      effect = ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        if (decision.kind !== 'enter' || payload.step !== 1) return decision
        if (payload.signal?.aborted) return decision
        const extra = []
        for (const message of decision.messages) {
          if (message?.source?.kind !== 'user') continue
          if (hinted.has(message.id)) continue
          const { ok, text } = textOfUserMessage(message)
          if (!ok) continue
          const match = matchSingleVideoLink(text)
          if (!match.hit) continue
          hinted.set(message.id, true)
          if (hinted.size > hintCap) hinted.clear()
          extra.push(createUserMessage({
            content: [{
              type: 'text',
              text: match.kind === 'short'
                ? '[bili-watch] 这条消息只有一条 b23.tv 短链。要读内容就调 bili_watch（会先按公共 DNS 展开短链）；展开失败再请用户贴 BV 号，不要凭短链猜内容。'
                : `[bili-watch] 这条消息只有一条 B 站视频链接（BV ${match.bv}）。要读内容就调 bili_watch（command=peek 需要下载 360p 约每分钟 1 MB）；用户没说要看时不要自己跑。`,
            }],
            source: {
              kind: name,
              form: 'notice',
              summary: boundContextSummary?.('检测到单条 B 站视频链接') ?? '检测到单条 B 站视频链接',
            },
          }))
        }
        if (!extra.length) return decision
        return { ...decision, messages: [...decision.messages, ...extra] }
      } catch (error) {
        ctx.logger?.info?.(`[bili-watch] 自动提示跳过：${String(error?.message || error)}`)
        return decision
      }
    }), 'bili-watch: 单条链接旁白')
    } catch (error) {
      // 上下文已销毁（插件在 import 期间被卸载）：静默放弃旁白。
      effect = null
    }
    void effect
  })()
}
