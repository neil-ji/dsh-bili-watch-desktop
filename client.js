/**
 * dsh-bili-watch（桌面端重构）— 浏览器半端。
 *
 * 桌面优先的三条设计约束：
 *   ① 主入口是左侧栏的独立面板（sidebar.panellist + main），设置页与插件页只放
 *      「摘要 + 跳转」，不再把一整页表单塞进插件详情页里；
 *   ② 视觉只用 DSH 的主题令牌（--dsw-alias-*），浅色/深色都跟着宿主走，
 *      不再出现「暗色主题里蹦出浅黄横幅」这种观感；
 *   ③ 不碰宿主或其他插件的 DOM：没有 shell.overlay 横幅，也没有改别人 top 的重排脚本。
 *
 * 数据全部来自宿主端点 /api/bili-watch（带页面令牌），前端不落任何凭证。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-bili-watch',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const PANEL_ID = 'bili-watch'
    const NS = 'bili-watch'
    const API = '/api/bili-watch'
    const POLL_IDLE = 10000
    const POLL_BUSY = 2500

    const ZH = {
      title: 'B 站视频',
      subtitle: '把视频读成文本交给对话里的模型：字幕 → 本地转写 → 抽帧 OCR。',
      usage: '用法：在对话里说「看看这个视频」并粘贴链接，或敲 /bili text <BV 或链接>。',
      refresh: '刷新',
      loading: '读取状态…',
      retry: '重试',
      close: '关闭',
      cancel: '取消',
      confirm: '确定',
      save: '保存',
      saved: '已保存',
      reset: '恢复默认',
      authTitle: '面板端点未授权',
      authBody: '这个页面拿不到面板令牌。请从 DSH 桌面窗口打开（不要用其它浏览器或局域网地址），然后重启 DSH。',
      warnTitle: '需要注意',
      statLogin: '账号',
      statDeps: '依赖',
      statCache: '缓存',
      signedIn: '已登录',
      signedOut: '匿名',
      signedInHint: 'AI 字幕可用',
      signedOutHint: '元数据/评论/弹幕照常可用',
      depReady: '{n} / {total} 就绪',
      cacheUsed: '已用 {size}',
      depsTitle: '运行依赖',
      depsInstallAll: '安装缺失项',
      depsInstall: '安装',
      depsInstalling: '安装中…',
      depsRemove: '删除',
      depsReady: '已就绪',
      depsMissing: '缺失',
      depsHint: '下载在后台执行；体积为预估值，实际以完成后为准。',
      depsRunning: '{name} 正在安装…',
      installingTitle: '正在安装依赖',
      installingHint: '后台执行，可以离开此页；装完自动刷新',
      installingCount: '安装中 {n} 项',
      installDone: '{name} 安装完成。',
      installFailed: '{name} 安装未完成：{why}',
      retry: '重试',
      retryMirror: '用国内镜像重试',
      installLog: '安装日志',
      accountTitle: '账号',
      accountScan: '扫码登录',
      accountRescan: '重新扫码',
      accountLogout: '退出登录',
      accountNeed: '登录后可用 AI 字幕（B 站官方字幕）。其它功能不需要登录。',
      accountUpdated: '更新于 {time}',
      accountIncomplete: '凭证不完整，实际按匿名运行',
      accountExpired: '凭证超过 30 天，建议重新扫码',
      accountMissing: '当前未登录',
      loginTitle: '扫码登录',
      loginWaiting: '请用 B 站手机 App 扫码，确认后自动完成。',
      loginScanned: '已扫码，请在手机上确认。',
      loginExpired: '二维码已过期，请重新扫码。',
      loginError: '登录失败',
      loginOk: '登录成功，凭证已保存。',
      loginCancel: '取消登录',
      cacheTitle: '抽帧缓存',
      cacheFiles: '{n} 个文件',
      cachePath: '位置',
      cacheChange: '更改位置…',
      cacheClear: '立即清理',
      cacheClearConfirm: '清空本插件的抽帧缓存？只删插件自己建的文件，缓存目录里别的文件不动。',
      cacheRule: '自动清理',
      cacheRuleText: '保留 {days} 天，总量超过 {max} MB 时从最旧的删起。',
      cacheDays: '天',
      cacheMaxMb: 'MB',
      cachePickUnsupported: '当前环境没有目录选择器，请手动填路径',
      tuningTitle: '参数',
      tuningBasic: '常用',
      tuningAdvanced: '高级设置',
      tuningHint: '改完立即生效，写进 deps/deps-config.json。「恢复默认」= 删掉这个键。',
      tuningRange: '范围 {min}–{max}',
      autoHintLabel: '链接自动提示',
      autoHintHint: '消息里只有一条 B 站链接时，给模型加一句「要不要看」的旁白（不会自动调用工具）。',
      on: '已开启',
      off: '已关闭',
      recentTitle: '最近一次调用',
      recentNone: '还没有记录。',
      recentFailed: '失败',
      recentOk: '成功',
      recentOpen: '在对话里用',
      recentCopy: '复制命令',
      confirmDelete: '删除 {name}？',
      confirmDeleteBody: '删掉后需要重新安装或重新登录才能恢复。',
      removeDone: '已删除：{list}',
      removeSkipped: '跳过：{list}',
      cleared: '已清理 {files} 个文件，释放 {size}。',
      clearedNothing: '没有可清理的文件。',
      installStarted: '已开始安装：{list}',
      installBlocked: '启动失败：{why}',
      openPanel: '打开面板',
      notInstalled: '未安装',
      settingsSummary: '依赖、登录、缓存与参数都在独立面板里管理，这里只显示摘要。',
    }

    const EN = {
      title: 'Bilibili',
      subtitle: 'Turn a video into text for the model: subtitles, local transcription, frame OCR.',
      usage: 'Ask in chat with a link, or run /bili text <BV or URL>.',
      refresh: 'Refresh',
      loading: 'Loading…',
      retry: 'Retry',
      close: 'Close',
      cancel: 'Cancel',
      confirm: 'Confirm',
      save: 'Save',
      saved: 'Saved',
      reset: 'Reset',
      authTitle: 'Panel endpoint not authorized',
      authBody: 'This page has no panel token. Open it from the DSH desktop window (not another browser or a LAN URL), then restart DSH.',
      warnTitle: 'Heads up',
      statLogin: 'Account',
      statDeps: 'Dependencies',
      statCache: 'Cache',
      signedIn: 'Signed in',
      signedOut: 'Anonymous',
      signedInHint: 'AI subtitles available',
      signedOutHint: 'Metadata, comments, danmaku still work',
      depReady: '{n} / {total} ready',
      cacheUsed: '{size} used',
      depsTitle: 'Dependencies',
      depsInstallAll: 'Install missing',
      depsInstall: 'Install',
      depsInstalling: 'Installing…',
      depsRemove: 'Remove',
      depsReady: 'Ready',
      depsMissing: 'Missing',
      depsHint: 'Downloads run in the background. Sizes are estimates.',
      depsRunning: 'Installing {name}…',
      installingTitle: 'Installing dependencies',
      installingHint: 'Runs in the background; you can leave this page',
      installingCount: '{n} installing',
      installDone: '{name} installed.',
      installFailed: '{name} did not finish: {why}',
      retry: 'Retry',
      retryMirror: 'Retry via mirror',
      installLog: 'Install log',
      accountTitle: 'Account',
      accountScan: 'Sign in',
      accountRescan: 'Sign in again',
      accountLogout: 'Sign out',
      accountNeed: 'Signing in enables AI subtitles. Everything else works anonymously.',
      accountUpdated: 'Updated {time}',
      accountIncomplete: 'Credential incomplete; running anonymously',
      accountExpired: 'Credential is over 30 days old; sign in again',
      accountMissing: 'Not signed in',
      loginTitle: 'Sign in',
      loginWaiting: 'Scan with the Bilibili mobile app; this panel updates automatically.',
      loginScanned: 'Scanned. Confirm on your phone.',
      loginExpired: 'The QR code expired. Try again.',
      loginError: 'Sign-in failed',
      loginOk: 'Signed in. Credential saved.',
      loginCancel: 'Cancel',
      cacheTitle: 'Frame cache',
      cacheFiles: '{n} files',
      cachePath: 'Location',
      cacheChange: 'Change…',
      cacheClear: 'Clear now',
      cacheClearConfirm: 'Clear this plugin frame cache? Only files created by the plugin are removed.',
      cacheRule: 'Auto cleanup',
      cacheRuleText: 'Keep {days} days; above {max} MB the oldest files go first.',
      cacheDays: 'days',
      cacheMaxMb: 'MB',
      cachePickUnsupported: 'No directory picker here; type the path instead',
      tuningTitle: 'Tuning',
      tuningBasic: 'Common',
      tuningAdvanced: 'Advanced',
      tuningHint: 'Applies immediately; stored in deps/deps-config.json. Reset removes the key.',
      tuningRange: 'Range {min}–{max}',
      autoHintLabel: 'Link auto-hint',
      autoHintHint: 'When a message is just a Bilibili link, add a one-line hint for the model (never calls the tool by itself).',
      on: 'On',
      off: 'Off',
      recentTitle: 'Last run',
      recentNone: 'No runs yet.',
      recentFailed: 'failed',
      recentOk: 'ok',
      recentOpen: 'Use in chat',
      recentCopy: 'Copy command',
      confirmDelete: 'Remove {name}?',
      confirmDeleteBody: 'You will need to install or sign in again to restore it.',
      removeDone: 'Removed: {list}',
      removeSkipped: 'Skipped: {list}',
      cleared: 'Cleared {files} files, freed {size}.',
      clearedNothing: 'Nothing to clear.',
      installStarted: 'Installing: {list}',
      installBlocked: 'Could not start: {why}',
      openPanel: 'Open panel',
      notInstalled: 'Not installed',
      settingsSummary: 'Dependencies, sign-in, cache and tuning live in the dedicated panel.',
    }

    const CSS = `
[data-bw]{color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;}
/* 主面板是整页内容，滚动必须自己管：shell 的 main 区不保证提供滚动容器，
   之前直接铺内容，超过一屏的部分会被裁掉、滚轮也没反应。
   flex:1 + height:100% 同时兼容「父级是 flex 列」与「父级有确定高度」两种布局。 */
[data-bw-page]{max-width:920px;margin:0 auto;padding:22px 24px 48px;display:flex;flex-direction:column;gap:14px;
  flex:1 1 auto;min-height:0;height:100%;max-height:100vh;box-sizing:border-box;overflow-y:auto;overflow-x:hidden;
  overscroll-behavior:contain;scrollbar-gutter:stable;}
[data-bw-page]::-webkit-scrollbar{width:10px;}
[data-bw-page]::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:5px;border:3px solid transparent;background-clip:content-box;}
[data-bw-head]{display:flex;align-items:flex-start;gap:14px;}
[data-bw-head-text]{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}
[data-bw-h1]{font-size:17px;font-weight:600;}
[data-bw-sub]{font-size:12px;color:var(--dsw-alias-label-secondary);}
[data-bw-card]{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;}
[data-bw-card-head]{display:flex;align-items:center;gap:8px;min-height:24px;}
[data-bw-card-title]{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary);}
[data-bw-spacer]{flex:1;}
[data-bw-btn]{height:28px;padding:0 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit;cursor:pointer;white-space:nowrap;}
[data-bw-btn]:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);}
[data-bw-btn]:disabled{opacity:.45;cursor:default;}
[data-bw-btn][data-variant=primary]{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff;font-weight:600;}
[data-bw-btn][data-variant=ghost]{border-color:transparent;color:var(--dsw-alias-label-secondary);}
[data-bw-btn][data-variant=danger]{color:var(--dsw-alias-state-error-primary);}
[data-bw-row]{display:flex;align-items:center;gap:10px;min-height:34px;}
[data-bw-dot]{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary);}
[data-bw-dot][data-tone=ok]{background:var(--dsw-alias-state-success-primary);}
[data-bw-dot][data-tone=warn]{background:var(--dsw-alias-state-warn-primary);}
[data-bw-dot][data-tone=bad]{background:var(--dsw-alias-state-error-primary);}
[data-bw-name]{flex:none;width:132px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-bw-hint]{font-size:11.5px;color:var(--dsw-alias-label-secondary);}
[data-bw-detail]{flex:1;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-bw-detail][data-tone=bad]{color:var(--dsw-alias-state-warn-primary);}
[data-bw-path]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;}
[data-bw-size]{flex:none;min-width:64px;text-align:right;font-size:11.5px;color:var(--dsw-alias-label-secondary);}
[data-bw-muted]{color:var(--dsw-alias-label-secondary);}
[data-bw-err]{color:var(--dsw-alias-state-error-primary);}
[data-bw-ok]{color:var(--dsw-alias-state-success-primary);}
[data-bw-warn]{color:var(--dsw-alias-state-warn-primary);}
[data-bw-mono]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
[data-bw-banner]{border:1px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-state-warn-primary);border-radius:10px;padding:9px 12px;background:var(--dsw-alias-bg-layer-1);font-size:12px;display:flex;gap:8px;align-items:flex-start;}
[data-bw-banner][data-tone=err]{border-left-color:var(--dsw-alias-state-error-primary);}
[data-bw-banner][data-tone=ok]{border-left-color:var(--dsw-alias-state-success-primary);}
[data-bw-stats]{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;}
[data-bw-stat]{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:9px 12px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:1px;min-width:0;}
[data-bw-stat-label]{font-size:11.5px;color:var(--dsw-alias-label-secondary);}
[data-bw-stat-value]{font-size:14.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-bw-bar]{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;}
[data-bw-bar-fill]{height:100%;background:var(--dsw-alias-brand-primary);}
[data-bw-dep]{display:grid;grid-template-columns:10px minmax(0,1fr) auto auto;align-items:center;gap:4px 12px;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1);}
[data-bw-card]>[data-bw-dep]:first-child{border-top:none;}
[data-bw-dep-main]{min-width:0;display:flex;flex-direction:column;gap:4px;}
[data-bw-dep-title]{display:flex;align-items:center;gap:8px;min-width:0;}
[data-bw-dep-name]{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-bw-dep-hint]{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}
[data-bw-dep-detail]{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-bw-dep][data-state=bad] [data-bw-dep-detail]{color:var(--dsw-alias-state-warn-primary);}
[data-bw-dep][data-state=run] [data-bw-dep-detail]{color:var(--dsw-alias-label-primary);}
[data-bw-chip]{font-size:11px;line-height:18px;padding:0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none;}
[data-bw-chip][data-tone=ok]{color:var(--dsw-alias-state-success-primary);border-color:currentColor;}
[data-bw-chip][data-tone=bad]{color:var(--dsw-alias-state-warn-primary);border-color:currentColor;}
[data-bw-chip][data-tone=run]{color:var(--dsw-alias-brand-primary);border-color:currentColor;}
[data-bw-dep-actions]{display:flex;gap:6px;justify-content:flex-end;align-items:center;}
[data-bw-progress]{height:5px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin-top:2px;}
[data-bw-progress]>i{display:block;height:100%;background:var(--dsw-alias-brand-primary);border-radius:3px;transition:width .5s ease;}
[data-bw-input]{height:28px;width:84px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit;}
[data-bw-mask]{position:fixed;inset:0;background:rgba(0,0,0,.38);display:flex;align-items:center;justify-content:center;z-index:60;}
[data-bw-modal]{width:min(420px,92vw);background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:12px;box-shadow:0 14px 44px rgba(0,0,0,.3);}
[data-bw-qr]{width:214px;height:214px;border-radius:10px;background:#fff;padding:6px;align-self:center;}
[data-bw-qr] img{width:100%;height:100%;display:block;}
[data-bw-actions]{display:flex;gap:8px;justify-content:flex-end;align-items:center;}
[data-bw-adv]{border-top:1px dashed var(--dsw-alias-border-l1);padding-top:10px;display:flex;flex-direction:column;gap:10px;}
[data-bw-kbd]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:1px 6px;background:var(--dsw-alias-bg-layer-2);}
[data-bw-lifecycle]{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);}
`

    // ── 工具函数 ─────────────────────────────────────────────────────────────
    function fmtBytes(bytes) {
      const n = Number(bytes) || 0
      if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`
      if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`
      if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
      return `${n} B`
    }

    function fmtTime(value) {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      return date.toLocaleString(undefined, { hour12: false })
    }

    function fmtDuration(ms) {
      const n = Number(ms)
      if (!Number.isFinite(n) || n <= 0) return '—'
      if (n < 1000) return `${n} ms`
      if (n < 60000) return `${(n / 1000).toFixed(1)} s`
      return `${Math.floor(n / 60000)} m ${Math.round((n % 60000) / 1000)} s`
    }

    function panelToken() {
      try { return typeof window === 'undefined' ? '' : String(window.__DSH_BILI_TOKEN__ || '') } catch { return '' }
    }

    async function api(path, body) {
      const headers = {}
      const token = panelToken()
      if (token) headers['x-bili-token'] = token
      const init = { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers }
      if (body !== undefined) {
        headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      let response
      try {
        response = await fetch(API + path, init)
      } catch (error) {
        throw new Error(String(error?.message || error))
      }
      let json = null
      try { json = await response.json() } catch {}
      if (json === null) throw new Error(`HTTP ${response.status}`)
      if (json.why === undefined && !response.ok) json.why = `HTTP ${response.status}`
      json.status = response.status
      return json
    }

    // ── 数据 hook ────────────────────────────────────────────────────────────
    function useStatus() {
      const [state, setState] = useState({ loading: true, data: null, error: '', forbidden: false })
      const timerRef = useRef(null)
      const aliveRef = useRef(true)

      const load = useCallback(async () => {
        try {
          const json = await api('/status')
          if (!aliveRef.current) return
          if (!json.ok) {
            const error = new Error(json.why || '状态读取失败')
            error.status = json.status
            throw error
          }
          setState({ loading: false, data: json.data, error: '', forbidden: false })
        } catch (error) {
          if (!aliveRef.current) return
          setState((prev) => ({
            loading: false,
            data: prev.data,
            error: String(error?.message || error),
            forbidden: prev.forbidden || error?.status === 403,
          }))
        }
      }, [])

      useEffect(() => {
        aliveRef.current = true
        load()
        return () => {
          aliveRef.current = false
          if (timerRef.current) clearTimeout(timerRef.current)
        }
      }, [load])

      useEffect(() => {
        const busy = state.data?.downloads?.running?.length > 0
        const delay = busy ? POLL_BUSY : POLL_IDLE
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          load()
        }, delay)
        return () => { if (timerRef.current) clearTimeout(timerRef.current) }
      }, [state.data, load])

      return { ...state, reload: load }
    }

    // ── 基础组件 ─────────────────────────────────────────────────────────────
    function Modal({ title, children, onClose }) {
      useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return h('div', {
        'data-bw': '',
        'data-bw-mask': '',
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
      }, h('div', { 'data-bw-modal': '', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { 'data-bw-card-head': '' },
          h('span', { 'data-bw-h1': '', style: { fontSize: '14px' } }, title),
          h('span', { 'data-bw-spacer': '' }),
          h('button', { 'data-bw-btn': '', 'data-variant': 'ghost', onClick: onClose, 'aria-label': 'close' }, '✕')),
        children))
    }

    function Notice({ tone, children }) {
      if (!children) return null
      return h('div', { 'data-bw-banner': '', 'data-tone': tone || '' }, h('span', {}, children))
    }

    function LoginDialog({ t, onClose, onDone }) {
      const [qr, setQr] = useState(null)
      const [state, setState] = useState('loading')
      const [error, setError] = useState('')

      useEffect(() => {
        let alive = true
        api('/login/qr', {})
          .then((json) => {
            if (!alive) return
            if (json.ok && json.data?.image) {
              setQr(json.data)
              setState('waiting')
            } else {
              setError(json.why || '二维码生成失败')
              setState('error')
            }
          })
          .catch((err) => { if (alive) { setError(String(err?.message || err)); setState('error') } })
        return () => { alive = false }
      }, [])

      useEffect(() => {
        if (!qr?.key || state === 'ok') return undefined
        let alive = true
        let timer = null
        const tick = async () => {
          if (!alive) return
          let json = null
          try { json = await api('/login/poll', { key: qr.key }) } catch { json = { state: 'error' } }
          if (!alive) return
          if (json.state === 'ok') {
            setState('ok')
            onDone()
            return
          }
          if (json.state === 'expired' || json.state === 'error') {
            setState(json.state)
            if (json.why) setError(json.why)
            return
          }
          setState(json.state === 'scanned' ? 'scanned' : 'waiting')
          timer = setTimeout(tick, 2500)
        }
        timer = setTimeout(tick, 1000)
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, [qr, state, onDone])

      const message = state === 'scanned'
        ? t('loginScanned')
        : state === 'expired'
          ? t('loginExpired')
          : state === 'error'
            ? `${t('loginError')}：${error}`
            : state === 'ok'
              ? t('loginOk')
              : t('loginWaiting')

      return h(Modal, { title: t('loginTitle'), onClose },
        qr?.image ? h('div', { 'data-bw-qr': '' }, h('img', { src: qr.image, alt: t('loginTitle'), width: 214, height: 214 })) : null,
        h('div', { 'data-bw-muted': '', style: { textAlign: 'center' } }, message),
        h('div', { 'data-bw-actions': '' },
          state === 'ok' ? null : h('button', { 'data-bw-btn': '', onClick: onClose }, t('loginCancel'))))
    }

    function ConfirmDialog({ t, title, body, confirmLabel, onConfirm, onClose }) {
      return h(Modal, { title, onClose },
        body ? h('div', { 'data-bw-muted': '' }, body) : null,
        h('div', { 'data-bw-actions': '' },
          h('button', { 'data-bw-btn': '', onClick: onClose }, t('cancel')),
          h('button', { 'data-bw-btn': '', 'data-variant': 'danger', onClick: onConfirm }, confirmLabel || t('confirm'))))
    }

    // ── 面板主体 ─────────────────────────────────────────────────────────────
    function Stats({ data, t }) {
      const deps = data?.deps || []
      const ready = deps.filter((dep) => dep.ok).length
      const cache = data?.cache || { bytes: 0, files: 0 }
      const signedIn = data?.credential?.state === 'ok'
      return h('div', { 'data-bw-stats': '' },
        h('div', { 'data-bw-stat': '' },
          h('span', { 'data-bw-stat-label': '' }, t('statLogin')),
          h('span', { 'data-bw-stat-value': '' }, signedIn ? t('signedIn') : t('signedOut')),
          h('span', { 'data-bw-hint': '' }, signedIn ? t('signedInHint') : t('signedOutHint'))),
        h('div', { 'data-bw-stat': '' },
          h('span', { 'data-bw-stat-label': '' }, t('statDeps')),
          h('span', { 'data-bw-stat-value': '' }, t('depReady', { n: ready, total: deps.length || 6 })),
          h('div', { 'data-bw-bar': '' }, h('div', { 'data-bw-bar-fill': '', style: { width: `${deps.length ? Math.round((ready / deps.length) * 100) : 0}%` } }))),
        h('div', { 'data-bw-stat': '' },
          h('span', { 'data-bw-stat-label': '' }, t('statCache')),
          h('span', { 'data-bw-stat-value': '' }, fmtBytes(cache.bytes)),
          h('span', { 'data-bw-hint': '' }, t('cacheFiles', { n: cache.files ?? 0 }))))
    }

    function DepRow({ dep, run, t, anyRunning, onInstall, onRemove }) {
      const state = run ? 'run' : dep.ok ? 'ok' : 'bad'
      // 已就绪不再加「已就绪」徽标：绿点 + 路径已经说清楚了；徽标只留给「缺失 / 进度」。
      const chip = run
        ? h('span', { 'data-bw-chip': '', 'data-tone': 'run' }, `${run.percent ?? 0}%`)
        : dep.ok
          ? null
          : h('span', { 'data-bw-chip': '', 'data-tone': 'bad' }, t('depsMissing'))
      const detailText = run
        ? `${run.stage || '安装中…'}${run.bytes ? ` · 已下载 ${fmtBytes(run.bytes)}` : ''}`
        : (dep.detail || (dep.ok ? t('depsReady') : t('depsMissing')))
      return h('div', { 'data-bw-dep': '', 'data-state': state },
        h('span', { 'data-bw-dot': '', 'data-tone': dep.ok ? 'ok' : 'warn' }),
        h('div', { 'data-bw-dep-main': '' },
          h('div', { 'data-bw-dep-title': '' },
            h('span', { 'data-bw-dep-name': '' }, dep.name),
            dep.hint ? h('span', { 'data-bw-dep-hint': '' }, dep.hint) : null,
            chip),
          h('div', { 'data-bw-dep-detail': '', title: detailText }, detailText),
          run ? h('div', { 'data-bw-progress': '' }, h('i', { style: { width: `${Math.max(3, run.percent || 0)}%` } })) : null),
        h('span', { 'data-bw-size': '' }, dep.ok ? fmtBytes(dep.size) : (dep.estimate || '')),
        h('div', { 'data-bw-dep-actions': '' },
          dep.id === 'credential'
            ? h('button', { 'data-bw-btn': '', onClick: () => onInstall('login') }, dep.ok ? t('accountRescan') : t('accountScan'))
            : dep.ok
              ? null
              : h('button', {
                'data-bw-btn': '',
                disabled: anyRunning || Boolean(run),
                onClick: () => onInstall(dep.id),
              }, run ? t('depsInstalling') : t('depsInstall')),
          dep.id === 'credential'
            ? (dep.ok ? h('button', { 'data-bw-btn': '', 'data-variant': 'ghost', onClick: () => onRemove('credential') }, t('accountLogout')) : null)
            : dep.removable && dep.ok
              ? h('button', { 'data-bw-btn': '', 'data-variant': 'ghost', onClick: () => onRemove(dep.id) }, t('depsRemove'))
              : null))
    }

    function DepRows({ deps, runningMap, anyRunning, onInstall, onRemove, t }) {
      return deps.map((dep) => h(DepRow, {
        key: dep.id,
        dep,
        run: runningMap.get(dep.id) || null,
        t,
        anyRunning,
        onInstall,
        onRemove,
      }))
    }

    function CacheCard({ data, t, onClear, onChange, notify }) {
      const cache = data?.cache || { bytes: 0, files: 0, days: 7, maxMb: 2048, dir: '' }
      const [days, setDays] = useState(String(cache.days ?? 7))
      const [maxMb, setMaxMb] = useState(String(cache.maxMb ?? 2048))
      const dirty = useRef(false)

      useEffect(() => {
        if (dirty.current) return
        setDays(String(cache.days ?? 7))
        setMaxMb(String(cache.maxMb ?? 2048))
      }, [cache.days, cache.maxMb])

      const percent = Math.min(100, Math.round(((Number(cache.bytes) || 0) / ((Number(cache.maxMb) || 2048) * 1024 * 1024)) * 100))

      const save = async () => {
        try {
          const json = await api('/config', { days: Number(days), maxMb: Number(maxMb) })
          if (!json.ok) throw new Error(json.why || '保存失败')
          dirty.current = false
          notify('ok', t('saved'))
          onChange()
        } catch (error) {
          notify('err', String(error?.message || error))
        }
      }

      return h('div', { 'data-bw-card': '' },
        h('div', { 'data-bw-card-head': '' },
          h('span', { 'data-bw-card-title': '' }, t('cacheTitle')),
          h('span', { 'data-bw-spacer': '' }),
          h('span', { 'data-bw-size': '' }, t('cacheFiles', { n: cache.files ?? 0 })),
          h('button', { 'data-bw-btn': '', 'data-variant': 'danger', onClick: onClear }, t('cacheClear'))),
        h('div', { 'data-bw-row': '' },
          h('div', { 'data-bw-bar': '', style: { flex: 1 } },
            h('div', { 'data-bw-bar-fill': '', style: { width: `${percent}%` } })),
          h('span', { 'data-bw-size': '' }, `${fmtBytes(cache.bytes)} / ${cache.maxMb} MB`)),
        h('div', { 'data-bw-row': '' },
          h('span', { 'data-bw-name': '' }, t('cachePath')),
          h('span', { 'data-bw-detail': '' }, h('span', { 'data-bw-path': '' }, cache.dir || '—')),
          h('button', { 'data-bw-btn': '', onClick: onChange }, t('cacheChange'))),
        h('div', { 'data-bw-row': '' },
          h('span', { 'data-bw-name': '' }, t('cacheRule')),
          h('span', { 'data-bw-detail': '' },
            h('span', { 'data-bw-hint': '' }, 'keep '),
            h('input', {
              'data-bw-input': '',
              type: 'number',
              min: 1,
              max: 365,
              value: days,
              onChange: (event) => { dirty.current = true; setDays(event.target.value) },
              'aria-label': t('cacheDays'),
            }),
            h('span', { 'data-bw-hint': '', style: { margin: '0 6px' } }, t('cacheDays')),
            h('span', { 'data-bw-hint': '' }, '· ≤ '),
            h('input', {
              'data-bw-input': '',
              type: 'number',
              min: 100,
              max: 65536,
              value: maxMb,
              onChange: (event) => { dirty.current = true; setMaxMb(event.target.value) },
              'aria-label': t('cacheMaxMb'),
            }),
            h('span', { 'data-bw-hint': '', style: { marginLeft: '6px' } }, t('cacheMaxMb'))),
          h('button', { 'data-bw-btn': '', onClick: save }, t('save'))))
    }

    function TuningRow({ item, value, range, t, onSave }) {
      const [draft, setDraft] = useState(String(value ?? ''))
      useEffect(() => { setDraft(String(value ?? '')) }, [value])
      const label = h('span', { 'data-bw-name': '' }, item.label)
      return h('div', { 'data-bw-row': '' },
        label,
        h('span', { 'data-bw-detail': '' },
          h('input', {
            'data-bw-input': '',
            type: 'number',
            value: draft,
            min: range?.[0],
            max: range?.[1],
            onChange: (event) => setDraft(event.target.value),
            'aria-label': item.label,
          }),
          h('span', { 'data-bw-hint': '', style: { marginLeft: '8px' } }, `${item.unit || ''} · ${t('tuningRange', { min: range?.[0] ?? '?', max: range?.[1] ?? '?' })}`)),
        h('button', {
          'data-bw-btn': '',
          disabled: String(value ?? '') === String(draft),
          onClick: () => onSave(Number(draft)),
        }, t('save')),
        h('button', { 'data-bw-btn': '', 'data-variant': 'ghost', onClick: () => onSave(null) }, t('reset')))
    }

    const TUNING_LABELS = {
      asrMaxSec: { zh: '转写时长上限', en: 'Transcription time limit', unit: 's' },
      maxFrames: { zh: '抽帧张数上限', en: 'Max frames', unit: '' },
      asrTimeoutSec: { zh: '转写超时', en: 'ASR timeout', unit: 's' },
      ffmpegTimeoutSec: { zh: 'ffmpeg 超时', en: 'ffmpeg timeout', unit: 's' },
      cmdTimeoutSec: { zh: '命令超时', en: 'Command timeout', unit: 's' },
      asrMemMB: { zh: '转写内存门槛', en: 'ASR memory gate', unit: 'MB' },
      lockTtlMin: { zh: '残留锁过期', en: 'Stale lock TTL', unit: 'min' },
      unitLimit: { zh: '单条内容上限', en: 'Per-item limit', unit: '' },
      textLimit: { zh: '文本层字数', en: 'Text layer chars', unit: '' },
      toolTextCap: { zh: '工具层总字数', en: 'Tool text cap', unit: '' },
      toolHead: { zh: '工具层头部字数', en: 'Tool head chars', unit: '' },
      dmBucketSec: { zh: '弹幕分桶', en: 'Danmaku bucket', unit: 's' },
      dmTop: { zh: '弹幕热区条数', en: 'Danmaku buckets', unit: '' },
      downloadMaxMB: { zh: '单文件下载上限', en: 'Download cap', unit: 'MB' },
      subRateMin10: { zh: '字幕语速下限 ×10', en: 'Min subtitle rate ×10', unit: '' },
      subRateMax10: { zh: '字幕语速上限 ×10', en: 'Max subtitle rate ×10', unit: '' },
      textBrief: { zh: '超长文本摘要', en: 'Brief length', unit: '' },
    }

    function TuningCard({ data, t, onSave, lang, onToggleAutoHint }) {
      const [advanced, setAdvanced] = useState(false)
      const tuning = data?.tuning || { values: {}, defaults: {}, ranges: {} }
      const autoHint = data?.ui?.autoHint !== false
      const basic = ['asrMaxSec', 'maxFrames']
      const rows = (keys) => keys.map((key) => {
        const meta = TUNING_LABELS[key] || { zh: key, en: key, unit: '' }
        return h(TuningRow, {
          key,
          item: { label: lang === 'en' ? meta.en : meta.zh, unit: meta.unit },
          value: tuning.values?.[key],
          range: tuning.ranges?.[key],
          t,
          onSave: (value) => onSave(key, value),
        })
      })
      const advancedKeys = Object.keys(tuning.values || {}).filter((key) => !basic.includes(key))
      return h('div', { 'data-bw-card': '' },
        h('div', { 'data-bw-card-head': '' },
          h('span', { 'data-bw-card-title': '' }, t('tuningTitle')),
          h('span', { 'data-bw-spacer': '' }),
          h('button', { 'data-bw-btn': '', 'data-variant': 'ghost', onClick: () => setAdvanced((value) => !value) },
            (advanced ? '▾ ' : '▸ ') + t('tuningAdvanced'))),
        ...rows(basic),
        advanced ? h('div', { 'data-bw-adv': '' }, ...rows(advancedKeys)) : null,
        h('div', { 'data-bw-row': '', style: { borderTop: '1px dashed var(--dsw-alias-border-l1)', paddingTop: '10px' } },
          h('span', { 'data-bw-name': '' }, t('autoHintLabel')),
          h('span', { 'data-bw-detail': '' }, t('autoHintHint')),
          h('button', { 'data-bw-btn': '', onClick: onToggleAutoHint }, autoHint ? t('on') : t('off'))),
        h('div', { 'data-bw-hint': '' }, t('tuningHint')))
    }

    function RecentCard({ data, t }) {
      const run = data?.lastRun
      const usage = '/bili text BV1xx411c7mD'
      if (!run) {
        return h('div', { 'data-bw-card': '' },
          h('div', { 'data-bw-card-head': '' }, h('span', { 'data-bw-card-title': '' }, t('recentTitle'))),
          h('div', { 'data-bw-row': '' }, h('span', { 'data-bw-hint': '' }, t('recentNone'))),
          h('div', { 'data-bw-row': '' },
            h('span', { 'data-bw-hint': '' }, t('usage')),
            h('span', { 'data-bw-spacer': '' }),
            h('code', { 'data-bw-kbd': '' }, usage)))
      }
      return h('div', { 'data-bw-card': '' },
        h('div', { 'data-bw-card-head': '' },
          h('span', { 'data-bw-card-title': '' }, t('recentTitle')),
          h('span', { 'data-bw-spacer': '' }),
          h('span', { 'data-bw-hint': '' }, fmtTime(run.at || run.time))),
        h('div', { 'data-bw-row': '' },
          h('span', { 'data-bw-dot': '', 'data-tone': run.ok ? 'ok' : 'bad' }),
          h('span', { 'data-bw-mono': '' }, `/bili ${run.command || ''}`),
          h('span', { 'data-bw-spacer': '' }),
          h('span', { 'data-bw-size': '' }, fmtDuration(run.ms)),
          h('span', { 'data-bw-hint': '' }, run.ok ? t('recentOk') : t('recentFailed'))),
        h('div', { 'data-bw-row': '' },
          h('span', { 'data-bw-hint': '' }, t('usage')),
          h('span', { 'data-bw-spacer': '' }),
          h('code', { 'data-bw-kbd': '' }, usage)))
    }

    function createPanel(services) {
      const { t, lang } = services
      return function Panel() {
        const status = useStatus()
        const [notice, setNotice] = useState(null)
        const [dialog, setDialog] = useState(null)
        const [busy, setBusy] = useState('')

        const notify = useCallback((tone, text) => { setNotice({ tone, text }) }, [])

        const data = status.data
        const runningList = data?.downloads?.running || []
        const runningMap = useMemo(() => new Map(runningList.map((item) => [item.target, item])), [runningList])
        const depNames = useMemo(() => {
          const map = {}
          for (const dep of data?.deps || []) map[dep.id] = dep.name
          map.all = t('depsTitle')
          return map
        }, [data?.deps, t])
        const anyRunning = runningList.length > 0 || Boolean(busy)

        const install = async (target, options = {}) => {
          if (target === 'login') { setDialog({ kind: 'login' }); return }
          setBusy(target)
          try {
            const json = await api('/download', { targets: [target], mirror: options.mirror || '' })
            if (!json.ok) notify('err', json.why || t('installBlocked', { why: '' }))
          } catch (error) {
            notify('err', String(error?.message || error))
          } finally {
            setBusy('')
            status.reload()
          }
        }

        const installMissing = async () => {
          const targets = (data?.deps || []).filter((dep) => !dep.ok && dep.id !== 'credential').map((dep) => dep.id)
          if (!targets.length) { notify('ok', t('depsReady')); return }
          try {
            const json = await api('/download', { targets })
            if (!json.ok) notify('err', json.why || t('installBlocked', { why: '' }))
          } catch (error) {
            notify('err', String(error?.message || error))
          } finally {
            status.reload()
          }
        }

        const remove = async (target) => {
          const dep = (data?.deps || []).find((item) => item.id === target)
          setDialog({
            kind: 'confirm',
            title: t('confirmDelete', { name: dep?.name || target }),
            body: t('confirmDeleteBody'),
            onConfirm: async () => {
              setDialog(null)
              try {
                const json = await api('/delete', { targets: [target] })
                const removed = json.data?.deleted || []
                const skipped = json.data?.skipped || []
                if (removed.length) notify('ok', t('removeDone', { list: removed.join(', ') }))
                if (skipped.length) notify('err', t('removeSkipped', { list: skipped.map((item) => `${item.id}：${item.why}`).join('；') }))
                if (!removed.length && !skipped.length) notify('ok', t('removeDone', { list: '—' }))
              } catch (error) {
                notify('err', String(error?.message || error))
              } finally {
                status.reload()
              }
            },
          })
        }

        const clearCache = () => {
          setDialog({
            kind: 'confirm',
            title: t('cacheClear'),
            body: t('cacheClearConfirm'),
            onConfirm: async () => {
              setDialog(null)
              try {
                const json = await api('/cache/clear', {})
                if (json.ok) {
                  const removed = json.data?.removed ?? 0
                  notify('ok', removed ? t('cleared', { files: removed, size: fmtBytes(json.data?.bytes) }) : t('clearedNothing'))
                } else {
                  notify('err', json.why || '清理失败')
                }
              } catch (error) {
                notify('err', String(error?.message || error))
              } finally {
                status.reload()
              }
            },
          })
        }

        const changeCache = async () => {
          const picker = services.uiWorkspace
          if (!picker?.pickDirectory) { notify('err', t('cachePickUnsupported')); return }
          let dir = null
          try { dir = await picker.pickDirectory() } catch { dir = null }
          if (!dir) return
          try {
            const json = await api('/cache/location', { dir })
            if (json.ok) notify('ok', `${t('saved')}：${dir}（重启 DSH 生效）`)
            else notify('err', json.why || '保存失败')
          } catch (error) {
            notify('err', String(error?.message || error))
          }
        }

        const saveTuning = async (key, value) => {
          try {
            const json = await api('/config', { tuning: { [key]: value } })
            if (!json.ok) throw new Error(json.why || '保存失败')
            notify('ok', t('saved'))
            status.reload()
          } catch (error) {
            notify('err', String(error?.message || error))
          }
        }

        const lastDownload = data?.downloads?.last || null
        const warnings = data?.warnings || []

        if (status.loading && !data) {
          return h('div', { 'data-bw': '', 'data-bw-page': '' }, h('div', { 'data-bw-muted': '' }, t('loading')))
        }
        if (status.forbidden) {
          return h('div', { 'data-bw': '', 'data-bw-page': '' },
            h('div', { 'data-bw-card': '' },
              h('span', { 'data-bw-h1': '' }, t('authTitle')),
              h('div', { 'data-bw-muted': '' }, t('authBody')),
              h('div', { 'data-bw-actions': '' }, h('button', { 'data-bw-btn': '', onClick: () => status.reload() }, t('retry')))))
        }
        if (status.error && !data) {
          return h('div', { 'data-bw': '', 'data-bw-page': '' },
            h(Notice, { tone: 'err' }, status.error),
            h('div', { 'data-bw-actions': '' }, h('button', { 'data-bw-btn': '', onClick: () => status.reload() }, t('retry'))))
        }

        return h('div', { 'data-bw': '', 'data-bw-page': '' },
          h('div', { 'data-bw-head': '' },
            h('div', { 'data-bw-head-text': '' },
              h('span', { 'data-bw-h1': '' }, t('title')),
              h('span', { 'data-bw-sub': '' }, t('subtitle'))),
            h('button', { 'data-bw-btn': '', onClick: () => status.reload() }, t('refresh'))),

          notice ? h(Notice, { tone: notice.tone }, notice.text) : null,
          status.error && data ? h(Notice, { tone: 'err' }, status.error) : null,
          warnings.length ? h(Notice, { tone: 'warn' }, `${t('warnTitle')}：${warnings.join('；')}`) : null,
          !anyRunning && lastDownload
            ? h('div', { 'data-bw-banner': '', 'data-tone': lastDownload.ok ? 'ok' : 'err', style: { alignItems: 'center' } },
              h('span', { style: { flex: 1 } },
                lastDownload.ok
                  ? t('installDone', { name: depNames[lastDownload.target] || lastDownload.target })
                  : t('installFailed', { name: depNames[lastDownload.target] || lastDownload.target, why: lastDownload.stage || '见安装日志' })),
              lastDownload.ok ? null : h('button', {
                'data-bw-btn': '',
                disabled: anyRunning,
                onClick: () => install(lastDownload.target, { retry: true }),
              }, t('retry')),
              lastDownload.ok
                ? null
                : h('button', {
                  'data-bw-btn': '',
                  'data-variant': 'ghost',
                  disabled: anyRunning,
                  onClick: () => install(lastDownload.target, { retry: true, mirror: 'cn' }),
                }, t('retryMirror')))
            : null,

          h(Stats, { data, t }),

          h('div', { 'data-bw-card': '' },
            h('div', { 'data-bw-card-head': '' },
              h('span', { 'data-bw-card-title': '' }, t('depsTitle')),
              anyRunning ? h('span', { 'data-bw-chip': '', 'data-tone': 'run' }, t('installingCount', { n: runningList.length })) : null,
              h('span', { 'data-bw-spacer': '' }),
              h('button', { 'data-bw-btn': '', 'data-variant': 'primary', disabled: anyRunning, onClick: installMissing }, t('depsInstallAll'))),
            ...DepRows({
              deps: data?.deps || [],
              runningMap,
              anyRunning,
              t,
              onInstall: install,
              onRemove: remove,
            }),
            h('div', { 'data-bw-hint': '' }, anyRunning ? t('installingHint') : t('depsHint'))),

          h(CacheCard, { data, t, onClear: clearCache, onChange: changeCache, notify }),

          h('div', { 'data-bw-card': '' },
            h('div', { 'data-bw-card-head': '' },
              h('span', { 'data-bw-card-title': '' }, t('accountTitle')),
              h('span', { 'data-bw-spacer': '' }),
              h('button', { 'data-bw-btn': '', onClick: () => install('login') },
                data?.credential?.state === 'ok' ? t('accountRescan') : t('accountScan'))),
            h('div', { 'data-bw-row': '' },
              h('span', { 'data-bw-dot': '', 'data-tone': data?.credential?.state === 'ok' ? 'ok' : 'warn' }),
              h('span', { 'data-bw-name': '' }, data?.credential?.state === 'ok' ? t('signedIn') : t('signedOut')),
              h('span', { 'data-bw-detail': '' },
                data?.credential?.state === 'ok'
                  ? t('accountUpdated', { time: fmtTime(data?.credential?.updatedAt) })
                  : data?.credential?.state === 'incomplete'
                    ? t('accountIncomplete')
                    : data?.credential?.state === 'expired'
                      ? t('accountExpired')
                      : t('accountMissing'))),
            h('div', { 'data-bw-hint': '' }, t('accountNeed'))),

          h(TuningCard, {
            data,
            t,
            lang,
            onSave: saveTuning,
            onToggleAutoHint: async () => {
              try {
                const json = await api('/config', { autoHint: !(data?.ui?.autoHint !== false) })
                if (!json.ok) throw new Error(json.why || '保存失败')
                status.reload()
              } catch (error) {
                notify('err', String(error?.message || error))
              }
            },
          }),
          h(RecentCard, { data, t }),

          dialog?.kind === 'login'
            ? h(LoginDialog, {
              t,
              onClose: () => setDialog(null),
              onDone: () => { setDialog(null); notify('ok', t('loginOk')); status.reload() },
            })
            : null,
          dialog?.kind === 'confirm'
            ? h(ConfirmDialog, {
              t,
              title: dialog.title,
              body: dialog.body,
              onClose: () => setDialog(null),
              onConfirm: dialog.onConfirm,
            })
            : null)
      }
    }

    // ── 侧栏图标 ─────────────────────────────────────────────────────────────
    // 侧栏图标：实心圆角屏 + 播放三角；颜色跟随宿主文字色，选中时更亮。
    function PanelIcon(props) {
      const size = Number(props?.size) > 0 ? Number(props.size) : 18
      const active = Boolean(props?.active)
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 64 64',
        'aria-hidden': true,
        style: { display: 'block', opacity: active ? 1 : 0.78 },
      },
      h('rect', { x: 3, y: 12, width: 58, height: 42, rx: 13, fill: 'currentColor' }),
      h('path', { d: 'M27 21.5 L40 33 L27 44.5 Z', fill: 'var(--dsw-alias-bg-base)' }),
      h('rect', { x: 12, y: 47, width: 20, height: 4, rx: 2, fill: 'var(--dsw-alias-bg-base)', opacity: 0.75 }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = (() => { try { return ctx.get('locale') } catch { return undefined } })()
        const uiWorkspace = (() => { try { return ctx.get('uiWorkspace') } catch { return undefined } })()

        const currentLang = () => {
          try {
            const snapshot = locale?.getSnapshot?.() || locale?.getLocale?.()
            const id = String(snapshot?.locale || snapshot?.id || snapshot?.lang || '')
            return id.toLowerCase().startsWith('en') ? 'en' : 'zh'
          } catch { return 'zh' }
        }

        let lang = currentLang()
        const dict = () => (lang === 'en' ? EN : ZH)
        const t = (key, vars) => {
          const template = dict()[key] ?? ZH[key] ?? key
          if (!vars) return template
          return String(template).replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name])))
        }

        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-bili-watch')
        style.textContent = CSS
        document.head.appendChild(style)
        if (typeof ctx.effect === 'function') ctx.effect(() => () => style.remove(), 'bili-watch: 面板样式')

        if (locale?.register) {
          const disposeLocale = locale.register(NS, { zh: ZH, en: EN })
          if (typeof disposeLocale === 'function' && typeof ctx.effect === 'function') ctx.effect(() => disposeLocale, 'bili-watch: 文案')
          if (typeof locale.subscribe === 'function' && typeof ctx.effect === 'function') {
            ctx.effect(() => {
              const off = locale.subscribe(() => { lang = currentLang() })
              return () => { try { off() } catch {} }
            }, 'bili-watch: 语言跟随')
          }
        }

        const services = { t, lang, uiWorkspace }

        const Panel = createPanel(services)

        const slots = ctx.slots
        slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: () => t('title'),
        }, PanelIcon))

        slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, Panel))
      },
    }
  },
})
