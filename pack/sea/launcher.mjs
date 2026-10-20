import { isSea, getAsset } from 'node:sea'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import { exec } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import * as tar from 'tar'

/**
 * 运行目录（把 .output 解包到这里再跑）—— **2026-10-19 修复：不再写死单一路径**。
 *
 * 实测故障：有些机器上 `%TEMP%` 对程序**不可写**（EPERM）。杀毒软件过滤驱动、Windows
 * 「受控文件夹访问」、企业策略、沙箱都能造成。原先写死 `%TEMP%/totoro-heaven-runtime`，
 * 一旦写不进去就**在解包阶段直接抛异常**——用户只看到窗口一闪而过 + 一行报错。
 *
 * 现在按优先级探测**可写**的候选目录（真写一个探针文件再删，不靠猜），第一个不行就换下一个。
 */
const RUNTIME_DIR_CANDIDATES = [
  path.join(os.tmpdir(), 'totoro-heaven-runtime'),
  ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'totoro-heaven', 'runtime')] : []),
  path.join(path.dirname(process.execPath), 'runtime'),
  path.join(os.homedir(), '.totoro-heaven', 'runtime'),
]

/** 实际使用的运行目录（`main()` 里探测后赋值） */
let RUNTIME_DIR = ''

/**
 * 打开默认浏览器 —— ⚠️ **2026-10-20 修复（用户反馈"控制台说会自动打开，但浏览器没开"）**。
 *
 * 原实现只有一行 `exec('start http://localhost:' + PORT)`，三个毛病：
 *   ① **没有回调** ⇒ `start` 失败时一个字节都不打印，用户只看到"浏览器将自动打开"然后什么都没有，
 *      连"为什么"都无从判断（就是这次遇到的情况）；
 *   ② 打开的是 `localhost`，而服务只绑 `127.0.0.1` —— IPv6 优先的机器上 `localhost` 先解析成 `::1`，
 *      浏览器可能直接"无法连接"（窗口开了也像没打开）；
 *   ③ 只押注 `start` 一条路：默认浏览器关联损坏、被安全软件拦、被组策略禁用时没有任何兜底。
 *
 * 现在：三重兜底（`start` → `rundll32 url.dll` → PowerShell `Start-Process`），每步失败都**说出原因**，
 * 三步都失败也一定打印"请手动访问 <地址>"，用户永远有一条能走的路。
 *
 * @param {string} url 要打开的地址（用 127.0.0.1，不用 localhost）
 * @param {() => void} [onDone] 全部尝试结束后的回调（"已在运行"那条分支靠它退出进程）
 */
function openBrowser(url, onDone) {
  /**
   * ⚠️ 2026-10-20 实测教训（**不要给 URL 加引号**）：
   *   写成 `start "" "http://127.0.0.1:3000/"` 时，node 的 `exec` 会先拼成
   *   `cmd.exe /d /s /c "start "" "http://...""` —— 引号在这一层被吃掉/错位，
   *   cmd 把那个空串当成窗口标题、后面就没有"要执行的命令"了 ⇒ **exit code 0 但什么都不打开**。
   *   实测对比：同一台机器上 `start <url>`（不加引号）能从 EXE 里正常拉起浏览器，
   *   加了 `""` 标题就"成功但静默失败"。本项目 URL 只有 `http://127.0.0.1:<port>/`，
   *   不含空格 / `&` / `^`，所以**不加引号是安全的**，且能绕过上面那层引号错位。
   */
  const attempts = [
    ['start', `start ${url}`],
    ['rundll32', `rundll32 url.dll,FileProtocolHandler ${url}`],
    ['powershell', `powershell -NoProfile -Command Start-Process ${url}`],
  ]
  const oneLine = (e) => String((e && e.message) || e).split(/[\r\n]/)[0]
  const next = (i) => {
    if (i >= attempts.length) {
      console.log(`  ⚠ 没能自动打开浏览器。请手动访问：${url}`)
      if (onDone) onDone()
      return
    }
    const [name, cmd] = attempts[i]
    try {
      exec(cmd, (err) => {
        if (err) {
          console.log(`  ℹ 自动打开浏览器（${name}）失败：${oneLine(err)}`)
          next(i + 1)
          return
        }
        console.log(`  ℹ 已用 ${name} 打开浏览器：${url}`)
        if (onDone) onDone()
      })
    } catch (e) {
      console.log(`  ℹ 自动打开浏览器（${name}）抛错：${oneLine(e)}`)
      next(i + 1)
    }
  }
  next(0)
}

/**
 * 探测「可写」的运行目录：真的写一个探针文件再删掉，**不靠猜**。
 * @returns 第一个可写的目录；全部不可写时返回 `null`
 */
function pickRuntimeDir() {
  for (const dir of RUNTIME_DIR_CANDIDATES) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const probe = path.join(dir, `.write-probe-${process.pid}`)
      fs.writeFileSync(probe, 'ok')
      fs.rmSync(probe, { force: true })
      return dir
    } catch {
      // 这个候选不可写（EPERM / 只读 / 受控文件夹）⇒ 试下一个；全部失败时由调用方给出明确提示
    }
  }
  return null
}
/**
 * 期望端口（可用环境变量覆盖）。**实际端口在运行时才定**：
 * 若它被占用，会自动顺延到下一个可用端口（见 `pickPort`），
 * 并把最终端口写进 `process.env` / 用于打印与打开浏览器。
 */
const PREFERRED_PORT = (() => {
  const n = Number(process.env.TOTORO_PORT)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 3000
})()
let PORT = PREFERRED_PORT
const ASSET_KEY = 'app.tar.gz'

/* ===== 端口处理（2026-09-18：修"端口被占就崩"）=====
 * 实测问题：3000 被别的实例/dev 服务占用时，Nitro 直接抛
 * `Error: listen EADDRINUSE: address already in use 127.0.0.1:3000`，
 * 用户只看到一大段栈、程序退出 —— 既没说是端口冲突、也没告诉怎么办。
 * 处理策略（三步，全部是"用户看得懂的行为"）：
 *   ① 该端口上已经跑着**本工具**（探测到页面特征）⇒ 直接打开浏览器、本进程退出（不重复起服务）；
 *   ② 该端口被**别的程序**占用 ⇒ 从 preferred+1 起找一个可用端口，用那个端口启动；
 *   ③ 连续若干端口都被占 ⇒ 打印一句人话再退出。
 */
const numOrNull = (line) => {
  const v = Number(String(line).trim())
  return Number.isInteger(v) && v > 0 && v < 65536 ? v : null
}

/** 该端口上是否已经跑着本工具（用页面特征判断，避免把别人的服务当自己的） */
async function looksLikeOurApp(port) {
  try {
    const ctrl = new AbortController()
    // ⚠️ 2026-09-21（审计）：原先 1200ms —— 冷启动时页面可能还没吐出来，会被判"不是本程序"，
    // 进而在"3000 被自家占用"时顺延出第二个实例（共享同一解包目录 ⇒ 互相踩）。放宽到 3 秒。
    const timer = setTimeout(() => ctrl.abort(), 3000)
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) return false
    const html = await res.text()
    return html.includes('龙猫天堂') || html.includes('Totoro Heaven')
  } catch {
    return false
  }
}

/** 探测"端口是否空闲"（能绑上就是空闲；绑完立刻释放） */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

async function pickPort() {
  /**
   * ⚠️ **2026-09-21 结构性修复（审计 B3）**：**探测整个候选端口段**，而不是只看首选端口。
   *
   * 原先只探 3000：若 3000 被别的程序占用、本程序已顺延到 3001，用户再双击一次时 3000 上不是我们的服务
   * ⇒ 起**第二个实例**；而第二个实例启动时会清空并重解包**共享目录**（`%TEMP%\totoro-heaven-runtime`）
   * ⇒ 正在服务的第一个实例开始偶发 500/`ERR_MODULE_NOT_FOUND`。
   * 判据：**"本工具是否已在运行"必须在整个候选端口段上判断**（空闲端口探测失败是瞬时的，代价可忽略）。
   */
  for (let p = PREFERRED_PORT; p <= PREFERRED_PORT + 20; p++) {
    if (await looksLikeOurApp(p)) {
      console.log(`  ℹ 检测到本工具已在 http://127.0.0.1:${p}/ 运行，直接打开浏览器（不再重复启动服务）。`)
      console.log('  ℹ 原因：同一时间只应运行一个本程序实例（多个实例会共用同一个临时解包目录，可能互相影响）。')
      /**
       * ⚠️ 2026-10-20：原来这里是 `exec('start ...')` 后**紧接着** `process.exit(0)` ——
       * 子进程（cmd start）还没真正拉起浏览器，父进程就退了，属于"看运气"的写法。
       * 现在交回给 openBrowser 的回调退出，并用 8 秒兜底超时防止卡住不退。
       */
      const url = `http://127.0.0.1:${p}/`
      const bail = setTimeout(() => process.exit(0), 8000)
      openBrowser(url, () => {
        clearTimeout(bail)
        process.exit(0)
      })
      return await new Promise(() => {
        /* 永挂：真正的退出由上面的回调 / 兜底超时完成 */
      })
    }
  }
  for (let p = PREFERRED_PORT; p <= PREFERRED_PORT + 20; p++) {
    if (await isPortFree(p)) {
      if (p !== PREFERRED_PORT) {
        console.log(`  ℹ 端口 ${PREFERRED_PORT} 已被其它程序占用，本次改用 ${p}。`)
      }
      return p
    }
  }
  console.error(
    `\n启动失败：端口 ${PREFERRED_PORT}~${PREFERRED_PORT + 20} 都被占用了。\n` +
      `请关掉占用这些端口的程序后重试，或用环境变量指定别的端口，例如：\n` +
      `    set TOTORO_PORT=4000 && totoro-heaven.exe\n`,
  )
  exec('pause')
  process.exit(1)
}

/**
 * 🔒 只绑本机 loopback：这个工具会读写**你本人的校园跑凭据**，绝不能被局域网访问。
 * Nitro 的 node-server 预设默认可能绑 0.0.0.0 → 这里显式收紧（用户显式设置 HOST 时不覆盖）。
 * ⚠️ 端口相关环境变量**在 pickPort() 之后**再写（见 main），否则会用到还没确定的 PORT。
 */
process.env.NITRO_HOST = process.env.NITRO_HOST || '127.0.0.1'
process.env.HOST = process.env.HOST || '127.0.0.1'
// NITRO_PORT / PORT 在 pickPort() 确定后写入（见 main）

// 打包脚本会把这行占位符替换为实际版本号
const APP_VERSION = '__APP_VERSION__'

/* ===== 终端横幅：FIGlet slant 字体 + 科技风配色 ===== */
const esc = (code) => `\u001b[${code}m`
const CLR = {
  reset: esc(0),
  bold: esc(1),
  italic: esc(3),
  cyan: esc(36),
  green: esc(32),
  yellow: esc(33),
  magenta: esc(35),
  blue: esc(34),
  white: esc(37),
  dim: esc(2),
}

/* ===== 终端横幅：FIGlet slant 字体艺术字 + 科技风配色 ===== */
// FIGlet slant 渲染的 "TOTORO HEAVEN"（npx figlet -f slant 生成）
const TITLE_LINES = [
  '  __________  __________  ____  ____     __  ___________ _    _________   __',
  ' /_  __/ __ \\/_  __/ __ \\/ __ \\/ __ \\   / / / / ____/   | |  / / ____/ | / /',
  '  / / / / / / / / / / / / /_/ / / / /  / /_/ / __/ / /| | | / / __/ /  |/ /',
  ' / / / /_/ / / / / /_/ / _, _/ /_/ /  / __  / /___/ ___ | |/ / /___/ /|  /',
  '/_/  \\____/ /_/  \\____/_/ |_|\\____/  /_/ /_/_____/_/  |_|___/_____/_/ |_/',
]

// 文本显示宽度：全角（CJK）字符计 2 列，其它（含 ANSI 码剔除后）计 1 列
const displayWidth = (s) => {
  let w = 0
  for (const ch of s) {
    w += (ch.codePointAt(0) > 0x1fff) ? 2 : 1
  }
  return w
}

// 把字符串填充/居中到指定显示宽度：不足则两侧对称补空格，超宽原样返回
const padTo = (s, width) => {
  const w = displayWidth(s)
  if (w >= width) return s
  const left = Math.floor((width - w) / 2)
  return ' '.repeat(left) + s + ' '.repeat(width - w - left)
}

// 把若干“样式文本 + 纯文本”对拼成整块居中横幅：取所有行纯文本的最大显示宽，整块左右留白对称
function centerBlock(items) {
  const max = Math.max(...items.map((p) => displayWidth(p.plain)))
  const pad = Math.max(0, Math.floor((terminalCols() - max) / 2))
  return items.map((p) => ' '.repeat(pad) + p.styled).join('\n')
}

function terminalCols() {
  try {
    const c = process.stdout.columns
    return (typeof c === 'number' && c > 30) ? c : 96
  } catch {
    return 96
  }
}

function buildBanner() {
  const it = CLR.bold + CLR.italic
  const plainLines = []
  const styledLines = []
  const push = (styled, plain) => { styledLines.push(styled); plainLines.push(plain) }

  const slashTop = '  ' + '\\/\\/'.repeat(20)
  const slashBot = '  ' + '/\\/\\'.repeat(20)
  push(CLR.cyan + slashTop + CLR.reset, slashTop)
  for (const line of TITLE_LINES) {
    push(it + CLR.cyan + line + CLR.reset, line)
  }
  const boxW = 74
  const boxTop = '┌' + '─'.repeat(boxW - 2) + '┐'
  const boxBot = '└' + '─'.repeat(boxW - 2) + '┘'

  // 盒子内两行：标题行（含版本）+ 副标题行，分别按盒子内宽居中
  const innerW = boxW - 2
  const title = `  Totoro Heaven · 龙猫天堂  v${APP_VERSION}`
  const subtitle = `阳光跑助手 · 本地 Web 服务`
  const boxTitle = '│' + padTo(title, innerW) + '│'
  const boxSub = '│' + padTo(subtitle, innerW) + '│'
  push(CLR.dim + boxTop + CLR.reset, boxTop)
  push(CLR.dim + boxTitle + CLR.reset, boxTitle)
  push(CLR.bold + CLR.magenta + boxSub + CLR.reset, boxSub)
  push(CLR.dim + boxBot + CLR.reset, boxBot)
  push(CLR.cyan + slashBot + CLR.reset, slashBot)
  push('', '')
  // ⚠️ 用 127.0.0.1 而不是 localhost：服务只绑 127.0.0.1，IPv6 优先的机器上 localhost 会先走 ::1（连不上）
  const line = `  ▶ 服务已启动，浏览器将自动打开  http://127.0.0.1:${PORT}/`
  push(CLR.green + '  ▶ ' + CLR.reset + '服务已启动，浏览器将自动打开  ' + CLR.cyan + `http://127.0.0.1:${PORT}/` + CLR.reset, line)
  return centerBlock(styledLines.map((s, i) => ({ styled: s, plain: plainLines[i] })))
}

const banner = () => buildBanner()

async function extractAssets() {
  if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  /**
   * ⚠️ 先清掉上一次解出来的 `server/` 与 `public/` 再解包：
   * 否则新版本与旧版本的残留会**混在同一个目录**里（实测：升到 1.1.9 后 temp 里仍留着 1.1.6 的贺图等文件），
   * 既占磁盘、也可能让"看到的页面"和"当前版本"不一致。`tar.x` 只覆盖同名文件、不会删除已消失的文件。
   */
  for (const sub of ['server', 'public']) {
    try {
      fs.rmSync(path.join(RUNTIME_DIR, sub), { recursive: true, force: true })
    } catch {
      /* 尽力而为：删不掉（例如被占用）也不影响本次启动，继续解包覆盖即可 */
    }
  }
  const buf = Buffer.from(getAsset(ASSET_KEY))
  const archive = path.join(RUNTIME_DIR, ASSET_KEY)
  fs.writeFileSync(archive, buf)
  await tar.x({ file: archive, cwd: RUNTIME_DIR })
  fs.rmSync(archive, { force: true })
}

/**
 * 等服务真的能访问了，再打开浏览器。
 *
 * ⚠️ 2026-10-20 修复（用户反馈"没自动打开"）：原实现里 `fetch` 的失败被 `.catch(() => {})` **完全吞掉**，
 * 一旦探测始终不成功（代理拦截 localhost、服务监听慢、端口被别的程序抢走…），
 * 表现出来的就是"横幅写着会自动打开，然后永远什么都不发生"，且**没有任何日志**可查。
 * 现在：
 *   · 每 10 秒打一行"还没就绪 + 具体原因（HTTP 状态 / 错误信息）"，下次再出问题能直接看出卡在哪；
 *   · 60 秒还没就绪就放弃自动打开，改为打印可手动点的地址（绝不让用户干等）；
 *   · 真正打开浏览器统一走 `openBrowser()`（三重兜底 + 失败原因）。
 */
function openBrowserWhenReady() {
  const url = `http://127.0.0.1:${PORT}/`
  let tries = 0
  const probe = setInterval(async () => {
    tries++
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) })
      if (r.ok) {
        clearInterval(probe)
        openBrowser(url)
        return
      }
      if (tries % 20 === 0) console.log(`  ℹ 服务还没就绪（第 ${tries} 次探测：HTTP ${r.status}），继续等…`)
    } catch (e) {
      if (tries % 20 === 0) {
        console.log(`  ℹ 服务还没就绪（第 ${tries} 次探测：${String((e && e.message) || e).split(/[\r\n]/)[0]}），继续等…`)
      }
    }
    if (tries === 120) {
      clearInterval(probe)
      console.log(`  ⚠ 等了 60 秒服务仍未就绪，这次不自动打开浏览器。请手动访问：${url}`)
    }
  }, 500)
}

async function main() {
  if (!isSea()) {
    console.error('此 EXE 须以打包后的 SEA 单文件运行（直接双击即可）。')
    process.exit(1)
  }
  // ① 先定端口（可能顺延；若已有本工具在跑就直接打开浏览器并退出）
  PORT = await pickPort()
  /**
   * ⚠️ 2026-09-20 审计修复（端口必须**强制覆盖**）：原先写 `process.env.NITRO_PORT || String(PORT)`，
   * 只要父进程/shell 里残留 `NITRO_PORT`（或 Windows 用户环境变量里设过，含无效空串），
   * 服务就会绑那个**旧端口**，而横幅与自动打开的浏览器用的是本次 `pickPort()` 选出的端口
   * ⇒ 用户看到"白页 / 打不开"，甚至点开的是**别的程序**。
   * 期望端口的唯一入口是 `TOTORO_PORT`（`pickPort` 已经消费它），这里不再给外部变量留后门。
   */
  process.env.NITRO_PORT = String(PORT)
  process.env.PORT = String(PORT)
  // ② 横幅要显示**实际**端口，所以放到定端口之后再打印
  console.log(banner())
  /**
   * ③ 探测可写运行目录（2026-10-19 修复）：`%TEMP%` 不可写时自动换到 LOCALAPPDATA / EXE 同级 / 主目录。
   *    全部不可写时给出**能照做的**提示，而不是抛一段堆栈让用户看不懂、窗口一闪而过。
   */
  const runtimeDir = pickRuntimeDir()
  if (!runtimeDir) {
    console.error('')
    console.error('启动失败：找不到可写的运行目录。已依次尝试：')
    for (const d of RUNTIME_DIR_CANDIDATES) console.error('  - ' + d)
    console.error('')
    console.error('常见原因：杀毒软件拦截、Windows「受控文件夹访问」、或该目录为只读。')
    console.error('处理办法：把本程序所在文件夹加入杀毒软件白名单，或右键「以管理员身份运行」。')
    console.error('')
    exec('pause')
    process.exit(1)
  }
  RUNTIME_DIR = runtimeDir
  /**
   * 🆕 2026-10-19：把「授权数据**可写**目录」也告诉服务端（`server/utils/license/instance.ts` 会读它）。
   * 背景：有些机器上 `%LOCALAPPDATA%` 与 `%TEMP%` **都不可写**（EPERM），那时授权文件必须落到
   * EXE 旁边 —— 这里用运行目录的**上一级**再加 `totoro-heaven-data`（EXE 版通常就是 exe 所在目录）。
   * ⚠️ **不要**改写成 `TOTORO_LICENSE_DIR`：那是"显式覆盖"，会让实例 ID 换位置 ⇒ 机器码变化 ⇒ 已发证书作废。
   */
  process.env.TOTORO_DATA_DIR =
    process.env.TOTORO_DATA_DIR || path.join(path.dirname(RUNTIME_DIR), 'totoro-heaven-data')
  await extractAssets()
  const entry = path.join(RUNTIME_DIR, 'server', 'index.mjs')
  console.log(`Server assets ready at ${RUNTIME_DIR}`)
  openBrowserWhenReady()
  await import(pathToFileURL(entry).href)
}

main().catch((e) => {
  console.error('启动失败:', e)
  exec('pause')
  process.exit(1)
})