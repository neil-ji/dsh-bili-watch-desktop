# dsh-bili-watch（桌面端重构版）

把 B 站视频读成模型能用的内容：元数据、评论、弹幕热区、AI 字幕、本地转写、抽帧 OCR。
提供 `/bili` 斜杠命令、`bili_watch` 工具，以及一个**桌面端优先的侧栏面板**（装依赖、扫码登录、管缓存、调参数）。

> 本项目是 [Sacredbluedragon/dsh-bili-watch](https://github.com/Sacredbluedragon/dsh-bili-watch)（0.3.3，MIT）的衍生重构版，
> **不是另起炉灶**。原作者的 CLI 核心、三级降级策略、缓存锁协议、第三方内容来源标注都被完整保留；
> 我改动的是宿主（`index.js`/`lib/`）与界面（`client.js`），以及一批在桌面端实际使用中暴露出来的缺陷。
> 原作者在 README 里把「看视频」拆成「字幕 → 转写 → OCR → 读帧」，并明确要求「降级时要说明原因，不能静默跳过」——
> 这个设计是这一版能站住的地基。原项目的版权声明与许可完整保留在 [LICENSE](LICENSE)。

---

## 为什么会有这一版

不是为了加功能，而是原版在 **DSH 桌面端**里落不了地。三个具体问题（都可复现）：

1. **入口埋得太深**。面板挂在「插件详情页」里，日常要用得先开设置 → 插件 → 找到卡片 → 进详情页；
   一页纵向排了 20 多个控件，没有分组。
2. **「一键下载」点了没反应**。`spawn('powershell.exe', …, { detached: true })` 在 Windows 的
   `DETACHED_PROCESS` 下没有控制台，PowerShell 会在 ~60 ms 内直接退出（退出码 0、零输出、什么都没装），
   而代码把 code 0 当成安装成功——于是「安装」永远无效，状态一闪而过。
3. **为了补状态而干扰宿主**。为了提示缺依赖，客户端往 `shell.overlay` 塞横幅，并每 2 秒遍历、改写
   **所有插件**横幅的 `top`；宿主侧 `GET /status` 每 8 秒顺手清缓存、用 `execFileSync` 探 ffmpeg，阻塞事件循环。

这一版的目标就三句话：**入口要顺手、状态要可信、不碰别人的东西。**
顺手修掉的还有 18 项安全问题和 16 项功能缺陷（逐条见文末「审计」）。

---

## 我做了哪些优化

### 一、界面：从「插件详情页里的表单」变成「侧栏里的一个页面」

- **独立面板**：`sidebar.panellist` 图标 + `main` 页面，一处入口；**设置页与插件详情页不再插入任何条目**
  （之前那两张摘要卡反而是重复信息）。
- **信息架构重排**：概览三卡（账号 / 依赖 / 缓存）→ 运行依赖（逐行 + 一键安装）→ 抽帧缓存 →
  账号 → 参数（常用 2 项 + 折叠的高级 15 项）→ 最近一次调用（附 `/bili` 用法示例）。
- **只用主题令牌**（`--dsw-alias-*`）：浅色/深色跟随宿主。原来硬编码的 `#fffbeb`/`#d97706` 在深色主题下很刺眼。
- **交互细节**：二维码从「服务端 SVG 字符串 + `dangerouslySetInnerHTML`」改成 PNG `data:` URL + `<img>`；
  删除确认从 `window.confirm` 换成支持 Esc / 点遮罩关闭的弹窗；改缓存目录改用宿主自带的
  `uiWorkspace.pickDirectory()`，不再弹一个宿主窗口之外的 PowerShell 目录框。
- **就绪判定不再是「文件存在」**：venv 刚建好、pip 还没装完时，旧逻辑已经报「已就绪」。
  现在要核对 `site-packages` 里真有 `faster_whisper` / `rapidocr_onnxruntime`，
  模型要核对 `snapshots/<hash>/` 里真有权重文件。

### 二、可靠性：安装看得见、失败说得出

- **逐项进度条 + 阶段文本**：接管安装脚本的 stdout/stderr，识别 `==> …`、`下载 …`、pip 的
  `Collecting/Installing`、`Successfully installed`、huggingface 的 tqdm 百分比，配合「已用时间 / 预估时长」
  平滑推进；yt-dlp 这类直接写目标文件的还会显示**已下载 X MB**。
- **进度只出现一次**：早期版本顶部有一张「正在安装」卡片、下面依赖行又显示一遍同样的 8%，属于重复；
  现在只在对应那一行里显示，卡片位置换成标题旁一句「安装中 N 项」。
- **成功要核对**：脚本退出码 0 也要检查产物是否真的出现，没有就按失败报——这正是问题 2 的直接补丁。
- **失败可自救**：保留真实错误行（如 `curl: (56) Recv failure: Connection was reset`），
  并给「重试 / 用国内镜像重试」两个按钮（`-Mirror cn`：GitHub 走 gh-proxy、PyPI 走清华、模型走 hf-mirror）。
  实测在本机 GitHub 直连被重置，点镜像后 5 秒内装好 yt-dlp。
- **轮询无副作用**：`GET /status` 不再清缓存、不再 `execFileSync`；ffmpeg 只在启动时异步探一次。
  状态计算全部走 20–60 秒的惰性缓存，面板 2.5–10 秒轮询也不会把宿主拖慢。
- **原子写**：配置文件先写临时文件再 rename；损坏的 JSON 只备份一次并按默认值继续，不会「改一个参数整份配置被清空」。

### 三、安全：把边界补上

| 问题 | 处理 |
|---|---|
| `/api/bili-watch` 只靠「回环 + Host + Origin」判断，本机任意进程可删凭证/改配置/起安装 | 每个宿主进程生成 32 字节随机**页面令牌**，经 `webServer.tapIndex` 注入 `index.html`；端点优先校验令牌（常量时间比较），回环判据仅作兼容回退 |
| 静默复制另一个产品（bili-duty）的登录 cookie | 删掉这条路径，只认本插件自己的 `credential.json` / `--cred` |
| 转写模型默认从第三方镜像拉取 | 默认端点改回 `huggingface.co`，镜像需显式设置 |
| `--out` 可写 UNC（`\\host\share`）与开机自启目录、后缀不限 | 拒绝 UNC / 自启动目录 / 可执行后缀；`sub --out` 补上自动建目录 |
| 落盘文本里的 ` ``` ` 能提前闭合「这是素材不是指令」的围栏 | 围栏长度按正文里最长的反引号自适应 |
| `--format json` 是唯一跳过注入扫描的分支 | 扫描移到底层输出之前，只写 stderr，不污染 JSON |
| 整段视频读进内存（上限可配到 4 GB） | 改流式落盘 `.part`，超限立即中止 |

### 四、工程：可维护、可测试

- 宿主半端拆成 `lib/` 八个模块（`config` / `cache` / `deps` / `cred` / `look` / `tool` / `routes` / `hints`），
  每个模块只做一件事，`index.js` 只负责装配。
- **去掉 `@deepseek-ai/dsh-tools` / `dsh-llm` 硬依赖**：工具用 registry 直收的 JSON Schema 定义，
  两个可选包缺席时不会静默少一个工具（原版缺 `dsh-tools` 时 `bili_watch` 会消失）。
- `tools/look.mjs` 上做了 12 处低风险补丁：数值参数校验（不再产生 `pNaN` 缓存目录）、`pickEvenly` 空列表、
  帧清单上限硬编码、ffmpeg 探测缓存与超时、流式下载、`--out` 收口、缺参退出码、若干 fetch 超时、
  默认模型端点、注入扫描顺序、围栏自适应、`sub --out` 建目录。
- 安装脚本执行前**兜底补 UTF-8 BOM**：PowerShell 5.1 会把无 BOM 的 `.ps1` 按 ANSI 解码，
  中文注释里的引号会把整份脚本解析成 `UnexpectedToken`（这个坑在开发中真实踩到过）。

---

## 功能

### 面板（左侧栏图标 `B 站视频`）

- **运行依赖**：ffmpeg / yt-dlp / 转写环境 / OCR 环境 / 转写模型 / 登录，逐行显示路径、体积、缺失原因；
  单项安装或「安装缺失项」，安装中显示进度条、百分比与脚本当前阶段。
- **抽帧缓存**：占用条、位置（宿主目录选择器）、立即清理、按天数/总量的自动清理规则。
- **账号**：扫码登录（PNG 二维码，确认后自动刷新）、退出登录。
- **参数**：常用两项常显，其余收进「高级设置」；另有「链接自动提示」开关。
- **最近一次调用**：时间、命令、成败、耗时，以及 `/bili` 的用法示例。

### 命令与工具

```text
/bili text BV1xx411c7mD            # 字幕 → 本地转写 → 抽帧 OCR，自动降级
/bili peek BV1xx411c7mD            # 先判断是口播还是画面（需下载 360p）
/bili search DeepSeek --days 3     # 最近 3 天发布
/bili comments BV1xx411c7mD 20     # 评论区
/bili danmaku BV1xx411c7mD         # 弹幕热区
/bili login                        # 生成二维码（也可在面板里扫）
/bili clean                        # 清空抽帧缓存
```

模型侧工具 `bili_watch`，`command` 支持
`search|hot|peek|view|sub|comments|danmaku|asr|frames|sheet|substrip|ocr|text`。

---

## 安装

本仓库是标准 DSH bundle（`dsh.bundle.patch` + `dsh.client`），无构建步骤：

```text
plugin_manager install_bundle  target = "<本目录的绝对路径>"
```

安装后重启 DSH（或刷新窗口）即可。也可以把它放进 profile 的
`node_modules/@local/dsh-bili-watch` 并加入 `dsh.profile.bundles`。

依赖（ffmpeg / yt-dlp / Python 环境 / 转写模型）默认装到本包 `deps/` 下，在面板里点选安装；
缓存与登录凭证在 `$DSH_HOME/bili-watch/`（`DSH_HOME` 默认 `~/.dsh`），卸载插件不会丢。

---

## 和上游 0.3.3 的差异（速查）

| 上游 | 这一版 |
|---|---|
| 面板在插件详情页，20+ 控件纵向排列 | 左侧栏独立面板；设置页/插件详情页零插入 |
| `shell.overlay` 横幅 + 改写其他插件 DOM | 没有全局横幅，不碰任何其他插件 |
| 硬编码颜色 | 只用 `--dsw-alias-*` 令牌 |
| 8 秒轮询 + 路由内清缓存 + 同步探 ffmpeg | 10 秒（安装中 2.5 秒），GET 无副作用 |
| Windows 上一键下载静默失效 | 不再 detached；进度条 + 阶段文本 + 产物核对 + 重试/镜像重试 |
| 设置页里的摘要卡 | 已移除（与侧栏入口重复） |
| SVG 二维码 + `dangerouslySetInnerHTML` | PNG data URL + `<img>` |
| PowerShell 目录选择框 | 宿主 `uiWorkspace.pickDirectory()` |
| `@deepseek-ai/dsh-tools` 缺失时工具静默消失 | 工具注册无外部依赖 |

---

## 验证到什么程度

- 10 个源文件 `node --check` 全过；bundle 安装/启用 `application: applied`。
- 槽位：`sidebar.panellist`（order 20）、`main` key `bili-watch` 均 active；
  `settings.section` 与 `plugins.bundle.config` 已确认没有本插件占用。
- 端点：`GET /status` 200 且两次调用零副作用；参数读写、缓存清理、下载白名单、
  跨源/非 JSON 请求 403、局域网不可达（服务只绑回环）逐项实测。
- 安装：GitHub 直连失败时保留真实错误行；镜像重试 5 秒装好 `yt-dlp.exe`（23.5 MB）并通过产物核对。
- 端到端：`bili_watch command=hot limit=3` 返回真实热榜并写入 `last-run.json`；`view` 返回标题/简介/热评。
- **未验证**：面板的实际渲染与浅/深色观感（没有浏览器控制权，只能确认槽位注册与数据链路）。

---

## 已知限制与安全提示

1. **依赖安装仍不做完整性校验**：脚本从 GitHub Releases / PyPI 下载并执行，`-Mirror cn` 会经过第三方中转。
   这一版把默认端点改回官方、把镜像变成显式选择、在 UI 里明示风险，但没有内置 SHA256 表——这是下一步该做的事。
2. **凭证是明文**：`$DSH_HOME/bili-watch/credential.json`，`0600` 在 Windows 上不生效，同机其他账户可能读到。
3. **通用 URL 不做内网过滤**：`/bili view <非 B 站 URL>` 交给 yt-dlp，别指向内网服务或云元数据地址。
4. **注入防护是启发式的**：来源标签 + 自适应围栏 + 关键词扫描都只是「提示」，不是隔离。
5. **依赖装在插件包内**：重装插件会丢 `deps/`（缓存与凭证在 `$DSH_HOME`，不受影响）。

---

## 审计

重构前我把整份代码读了一遍（宿主 1873 行 + CLI 3577 行），顺手做了一次安全与缺陷梳理：
18 项安全问题、16 项功能缺陷。**这些绝大多数是「桌面端真正用起来才会暴露」的工程问题，
不是设计问题**——原版的降级链、缓存锁、来源标注经得起看，真正麻烦的是安装链路、
`--out` 的路径收口、注入扫描的覆盖范围，以及宿主侧的端点与轮询写法。
每一项都在上文对应位置说明了「原来怎样、现在怎样」，没有埋在提交历史里。

---

## 许可与致谢

- **上游**：[dsh-bili-watch](https://github.com/Sacredbluedragon/dsh-bili-watch) — 作者 **Sacredbluedragon**。
  本仓库保留其 MIT 许可与版权声明，`tools/look.mjs`、`scripts/fetch-deps.*`、`deps/_bili-asr.py`
  基本原样沿用（仅做本文列出的补丁）。如果这些改动里有上游愿意吸收的部分，
  也欢迎以 patch 形式回流，而不是长期分叉。
- 上游 README 中致谢的两个同类项目：
  [`dsh-bilibili-video-summary`](https://github.com/Aurum807)（Aurum807）与
  [`dsh-bilibili-subtitles`](https://github.com/Chenfan2)（Chenfan2），
  以及 ASR 幻觉证伪方法来源 [`video-watch-plus`](https://github.com/xinhailaopo/video-watch-plus)（MIT）。
- 第三方组件许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

本项目同样以 **MIT** 分发，见 [LICENSE](LICENSE)。
