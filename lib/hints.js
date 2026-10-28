/**
 * 「用户只贴了一条视频链接」的识别器（不联网、不写盘）。
 *
 * 判定口径：剥掉客户端壳 → 命中恰好 1 条链接 → 链接之外没有别的字。
 * 只有这种消息才加一句旁白，绝不替用户调用工具。
 */

const RE_FULL = /https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]{10})(?:[/?#][^\s<>"'）)]*)?/gi
const RE_SHORT = /https?:\/\/b23\.tv\/[0-9A-Za-z]{5,12}(?:[/?#][^\s<>"'）)]*)?/gi
const RE_BVID_Q = /https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/[^\s<>"'）)]*?[?&]bvid=(BV[0-9A-Za-z]{10})[^\s<>"'）)]*/gi
const RE_BARE = /(?<![0-9A-Za-z])BV[0-9A-Za-z]{10}(?![0-9A-Za-z])/g

const WRAPPERS = [
  /<system-reminder[\s\S]*?<\/system-reminder>/gi,
  /<attached_files>[\s\S]*?<\/attached_files>/gi,
  /<user_query>/gi,
  /<\/user_query>/gi,
]
const LINK_ANY = /bilibili\.com\/video\/|b23\.tv\/|BV[0-9A-Za-z]{10}/

function stripWrappers(raw) {
  let text = String(raw ?? '')
  let quoted = false
  for (const wrapper of WRAPPERS) {
    text = text.replace(wrapper, (match) => {
      if (LINK_ANY.test(match)) quoted = true
      return ' '
    })
  }
  text = text.replace(/<([^<>\s]{8,})>/g, '$1')
  const kept = []
  for (const line of text.split('\n')) {
    if (/^\s*>/.test(line)) {
      if (LINK_ANY.test(line)) quoted = true
      continue
    }
    kept.push(line)
  }
  return { text: kept.join('\n'), quoted }
}

/**
 * @returns {{hit: false, why: string} | {hit: true, kind: 'full'|'short'|'bare', bv: string}}
 */
export function matchSingleVideoLink(raw) {
  const { text, quoted } = stripWrappers(raw)
  if (quoted) return { hit: false, why: '链接出现在引用/附件里' }
  if (!text.trim()) return { hit: false, why: '空消息' }
  if (/^\s*\//.test(text)) return { hit: false, why: '斜杠命令' }

  const hits = []
  let match
  RE_FULL.lastIndex = 0
  while ((match = RE_FULL.exec(text))) hits.push({ kind: 'full', bv: match[1], start: match.index, end: match.index + match[0].length })
  RE_SHORT.lastIndex = 0
  while ((match = RE_SHORT.exec(text))) hits.push({ kind: 'short', bv: '', start: match.index, end: match.index + match[0].length })
  RE_BVID_Q.lastIndex = 0
  while ((match = RE_BVID_Q.exec(text))) hits.push({ kind: 'full', bv: match[1], start: match.index, end: match.index + match[0].length })
  RE_BARE.lastIndex = 0
  while ((match = RE_BARE.exec(text))) hits.push({ kind: 'bare', bv: match[0], start: match.index, end: match.index + match[0].length })

  hits.sort((a, b) => a.start - b.start || b.end - a.end)
  const unique = []
  for (const hit of hits) {
    const last = unique[unique.length - 1]
    if (last && hit.start < last.end) continue
    unique.push(hit)
  }
  if (unique.length === 0) return { hit: false, why: '没有视频链接' }
  if (unique.length > 1) return { hit: false, why: `有 ${unique.length} 个链接` }
  const one = unique[0]
  const residual = (text.slice(0, one.start) + text.slice(one.end))
    .replace(/\s+/g, '')
    .replace(/[。，、！？!?,.;；:：·…~～—\-"'“”‘’（）()【】\[\]]/g, '')
  if (residual) return { hit: false, why: `链接外还有字：「${residual.slice(0, 20)}」` }
  return { hit: true, kind: one.kind, bv: one.bv }
}

/** 从一条 UserMessage 里取纯文本（有图片/文件块就不算「只贴了链接」）。 */
export function textOfUserMessage(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  if (blocks.some((block) => block && block.type !== 'text')) return { ok: false, text: '' }
  const text = blocks.filter((block) => block && block.type === 'text').map((block) => block.text || '').join('\n')
  return { ok: true, text }
}
