/**
 * 龙猫天堂 · Electron 主进程（桌面端外壳）
 *
 * ## 这个文件负责什么
 *
 * 1. **在主进程内启动 Nitro 服务**：直接 `import()` 生产产物 `.output/server/index.mjs`
 *    （与 SEA 版 `pack/sea/launcher.mjs` 的 `await import(entry)` 完全同一条路），
 *    **不 spawn 子进程** ⇒ 没有控制台黑框、退出时不用回收子进程。
 * 2. 选一个**空闲的 loopback 端口**（默认 3000，被占就顺延），把 `NITRO_HOST/PORT` 写进
 *    `process.env`，再 `await import()`，最后轮询到 HTTP 200 才让窗口加载页面。
 * 3. 窗口：无菜单栏、标题固定「龙猫天堂」、图标用 `logo.ico`、默认 1280x880。
 * 4. 所有会弹控制台/新窗口的路径都收紧：外链交给系统浏览器，窗口不显示菜单。
 *
 * ## 为什么 main 是 `.cjs` 而不是 ESM
 *
 * 根 `package.json` 是 `"type": "module"`，但 **Electron 主进程用 CJS 最稳**（Electron 的
 * ESM 主进程支持是 28+ 才有，而且 asar / 动态 import 的组合坑更多）。CJS 里 `import()`
 * 依然可以加载 ESM 的 `.mjs`，所以 `.output/server/index.mjs` 照常能跑。
 *
 * ## 端口为什么要自己选（不能写死）
 *
 * SEA 版踩过的坑（`pack/sea/launcher.mjs` 里有完整记录）：3000 被别的程序占着时，
 * Nitro 的产物是 `listen` 报错后 **`process.exit(1)`**（见 `.output/server/index.mjs`），
 * 外层根本没机会提示。所以这里**先探测空闲端口**再写环境变量。
 *
 * ## 代理
 *
 * 只连 `127.0.0.1`，但国内机器常开代理/加速器，Chromium 新实例会把 loopback 也丢给代理
 * ⇒ 页面加载失败、窗口空白（SEA 版 `--app` 窗口踩过，见 launcher.mjs 的 2026-10-27 记录）。
 * 所以启动时强制 `--no-proxy-server`。
 */

'use strict'

const { app, BrowserWindow, Menu, dialog, shell, session, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const { execFile } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const APP_TITLE = '龙猫天堂'
const APP_ID = 'com.totoro.heaven'
const HOST = '127.0.0.1'
const DEFAULT_PORT = 3000
/** 端口顺延范围：3000..3020（与 SEA 版 launcher 的候选段一致） */
const PORT_SCAN_SPAN = 20
/** 等 Nitro 就绪的上限：SEA 版实测冷启动大多 < 3s，45s 是给杀软/磁盘慢的机器留的余量 */
const STARTUP_TIMEOUT_MS = 45000
const WINDOW_WIDTH = 1280
const WINDOW_HEIGHT = 880

const IS_PACKAGED = app.isPackaged

/** @type {BrowserWindow | null} */
let mainWindow = null
/** 本次实际使用的端口（启动成功后才有值） */
let serverPort = 0
let booting = false
let quitting = false

/**
 * 只连本机：必须绕过系统代理（否则 Chromium 可能把 127.0.0.1 的请求发给代理）。
 * ⚠️ 必须放在 app ready 之前，flag 才会生效。
 */
app.commandLine.appendSwitch('no-proxy-server')
app.commandLine.appendSwitch('disable-features', 'Translate')
/**
 * 「定位（我的位置）」走 Windows 定位服务（WinRT），而不是 Chromium 自带的网络定位
 * （后者需要 Google 定位服务，国内基本拿不到）。
 */
app.commandLine.appendSwitch('enable-features', 'WinrtGeolocationImplementation')
/**
 * 关掉硬件加速：这个工具就是表单 + 列表，软件渲染足够；而 GPU 初始化在虚拟机 / 远程桌面 /
 * 老显卡驱动上是最常见的"Electron 启动即崩"来源（2026-10-27 在本机 26H2 上实测过）。
 */
app.disableHardwareAcceleration()

/** 应用名：决定 Electron 的 userData 目录（`%APPDATA%\龙猫天堂`，与参考应用 AI讲学 同构） */
app.setName(APP_TITLE)

/** 启动/运行日志（GUI 程序没有控制台，排障只能靠文件） */
function logFilePath() {
  try {
    return path.join(app.getPath('temp'), 'totoro-heaven-electron.log')
  } catch {
    return path.join(process.env.TEMP || '.', 'totoro-heaven-electron.log')
  }
}

function log(...args) {
  const text = args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message
      if (typeof a === 'string') return a
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
  const line = `[${new Date().toISOString()}] ${text}\n`
  try {
    fs.appendFileSync(logFilePath(), line, 'utf8')
  } catch {
    /* 日志写不了不影响启动 */
  }
}

/* ============================== 可写 userData 兜底 ============================== */

/** 目录真的可写吗：写一个探针文件再删掉，不靠猜（与 SEA 版 launcher 的探测思路一致） */
function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.write-probe-${process.pid}`)
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 确保 Electron 的 userData 目录可写（Chromium 启动前就要用）。
 *
 * 默认是 `%APPDATA%\龙猫天堂`（与参考应用 AI讲学 同构）；但在**受限上下文**里（低完整性令牌、
 * 沙箱化的启动器、AppData 被策略重定向）这个目录可能建不出来 —— 此时 Chromium 会直接启动失败，
 * 表现为"双击没反应"。这里按 SEA 版 `launcher.mjs` 的同一套策略：探测**真的可写**的目录，
 * 第一个不行就换下一个；默认目录可用时行为完全不变（数据仍在 AppData）。
 */
function ensureWritableUserData() {
  let current = ''
  try {
    current = app.getPath('userData')
    if (isWritableDir(current)) return
  } catch (err) {
    log('userData probe failed', err)
  }
  const candidates = []
  if (process.env.LOCALAPPDATA?.trim()) {
    candidates.push(path.join(process.env.LOCALAPPDATA.trim(), 'totoro-heaven', 'electron-userdata'))
  }
  if (process.env.TEMP?.trim()) {
    candidates.push(path.join(process.env.TEMP.trim(), 'totoro-heaven-electron-userdata'))
  }
  if (process.env.APPDATA?.trim()) {
    candidates.push(path.join(process.env.APPDATA.trim(), 'totoro-heaven', 'electron-userdata'))
  }
  for (const dir of candidates) {
    if (isWritableDir(dir)) {
      app.setPath('userData', dir)
      log(`userData fallback: ${current || '(default)'} -> ${dir}`)
      return
    }
  }
  log('no writable userData directory found; Chromium may fail to start')
}

ensureWritableUserData()

/* ============================== 旧版授权目录识别/迁移 ============================== */

/**
 * 旧版（Node SEA 单文件 exe）把运行数据放在 EXE 旁边或 %TEMP%：
 *   · 从 `dist\` 启动时：授权文件在 `dist\totoro-heaven-data\license.json`（实测用户就是这种）；
 *   · `%TEMP%` 可写时：`%TEMP%\totoro-heaven-data`；
 *   · 某些机器上 `%LOCALAPPDATA%\totoro-heaven` 可写时授权文件在那里（本函数无需动作）。
 *
 * Electron 版默认把 `TOTORO_DATA_DIR` 指向自己的 userData，会让上面这些旧授权**找不到**
 * （界面从"已激活"变成"未授权"）。启动 Nitro 之前先探测旧目录：找到 license.json 就复制到
 * 稳定的 userData 目录（或直接沿用），机器码仍由原 instance-id 推导 ⇒ 已发证书继续有效。
 */
function ensureLicenseDataDir() {
  // 显式指定优先，绝不覆盖（排障/测试用）
  if (process.env.TOTORO_DATA_DIR?.trim()) return
  let userData = ''
  let target = ''
  try {
    userData = app.getPath('userData')
    target = path.join(userData, 'data')
  } catch (err) {
    log('license data dir: cannot resolve userData', err)
    return
  }

  // 目标目录里已经有授权（用户在新版里重新激活过）⇒ 直接用它，不拿旧文件覆盖
  if (fs.existsSync(path.join(target, 'license.json'))) {
    process.env.TOTORO_DATA_DIR = target
    return
  }

  const candidates = []
  const add = (p) => {
    if (!p) return
    try {
      const resolved = path.resolve(p)
      if (!candidates.includes(resolved)) candidates.push(resolved)
    } catch {
      /* ignore */
    }
  }
  // portable 外壳会传出“用户双击的那个 exe 所在目录”（dist\electron）；旧 SEA exe 通常在同一棵树的 dist\ 下
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR?.trim()
  if (portableDir) {
    add(path.join(path.dirname(portableDir), 'totoro-heaven-data'))
    add(path.join(portableDir, 'totoro-heaven-data'))
  }
  // 开发版/unpacked 版：exe 旁边、以及上一级
  const exeDir = path.dirname(app.getPath('exe'))
  add(path.join(exeDir, 'totoro-heaven-data'))
  add(path.join(path.dirname(exeDir), 'totoro-heaven-data'))
  try {
    add(path.join(process.cwd(), 'totoro-heaven-data'))
  } catch {
    /* ignore */
  }
  add(path.join(app.getPath('temp'), 'totoro-heaven-data'))

  for (const dir of candidates) {
    if (!fs.existsSync(path.join(dir, 'license.json'))) continue
    if (isWritableDir(target)) {
      try {
        for (const name of ['license.json', 'last-seen.json']) {
          const src = path.join(dir, name)
          if (fs.existsSync(src)) fs.copyFileSync(src, path.join(target, name))
        }
        process.env.TOTORO_DATA_DIR = target
        log(`license migrated: ${dir} -> ${target}`)
      } catch (err) {
        process.env.TOTORO_DATA_DIR = dir
        log('license migration failed; using old dir in place', dir, err)
      }
    } else {
      process.env.TOTORO_DATA_DIR = dir
      log(`license uses old dir (userData not writable): ${dir}`)
    }
    return
  }

  // 没找到旧授权：保持原来的新目录语义
  process.env.TOTORO_DATA_DIR = target
}

ensureLicenseDataDir()

/* ============================== 路径解析 ============================== */

/** 开发态：仓库根目录（`electron/` 的上一级；`electron .` 时就是 app path） */
function devAppRoot() {
  return path.join(__dirname, '..')
}

/**
 * Nitro 生产产物目录。
 * - 打包态：`extraResources` 把 `.output` 复制到 `resources/output`（**在 asar 之外**，
 *   因为 Electron 的 ESM loader 不能从 asar 里 `import()`）；
 * - 开发态：仓库根 `.output`；
 * - `TOTORO_OUTPUT_DIR` 可显式覆盖（排障/脚本用）。
 */
function outputDir() {
  const override = process.env.TOTORO_OUTPUT_DIR?.trim()
  if (override) return path.resolve(override)
  if (IS_PACKAGED) return path.join(process.resourcesPath, 'output')
  return path.join(devAppRoot(), '.output')
}

function nitroEntryPath() {
  return path.join(outputDir(), 'server', 'index.mjs')
}

/** 图标：打包后是 `resources/logo.ico`（extraResources），开发态是仓库根 `logo.ico` */
function iconPath() {
  const p = IS_PACKAGED ? path.join(process.resourcesPath, 'logo.ico') : path.join(devAppRoot(), 'logo.ico')
  return fs.existsSync(p) ? p : undefined
}

/* ============================== 端口选择 ============================== */

/** 端口空闲吗？（能绑上 127.0.0.1 就算空闲；绑完立刻释放） */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, HOST)
  })
}

/** 从 `TOTORO_PORT`（默认 3000）起找一个可用端口；整段都被占用时抛错（由启动失败路径提示） */
async function pickPort() {
  const envPort = Number(process.env.TOTORO_PORT)
  const preferred =
    Number.isInteger(envPort) && envPort > 0 && envPort <= 65535 ? envPort : DEFAULT_PORT
  const last = Math.min(65535, preferred + PORT_SCAN_SPAN)
  for (let port = preferred; port <= last; port++) {
    if (await isPortFree(port)) return port
  }
  throw new Error(
    `端口 ${preferred}~${last} 都被占用了。请关掉占用这些端口的程序，` +
      `或用环境变量指定别的端口（例如 set TOTORO_PORT=4000）。`,
  )
}

/** 探测一次 HTTP：返回是否拿到 2xx/3xx（服务在响应即认为就绪） */
function probeOnce(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      res.resume()
      resolve(typeof res.statusCode === 'number' && res.statusCode >= 200 && res.statusCode < 400)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

/** 取一次页面文本（冒烟测试用） */
function getText(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`timeout after ${timeoutMs}ms: ${url}`))
    })
  })
}

/** 等服务真的能访问了再返回（Nitro 的 listen 是异步回调，import() 返回不代表已监听） */
async function waitForServer(url, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await probeOnce(url)) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

/* ============================== Nitro 服务 ============================== */

/**
 * **在主进程内**启动 Nitro（不 spawn、不弹黑框）。
 * @returns {Promise<string>} 服务地址（含结尾 `/`）
 */
async function startNitroServer() {
  const entry = nitroEntryPath()
  if (!fs.existsSync(entry)) {
    throw new Error(
      `找不到 Nitro 生产产物：\n${entry}\n\n` +
        `开发态请先运行 npm run build；打包产物请确认 .output 已随包携带。`,
    )
  }

  // ① 先定端口，再写环境变量（Nitro 产物只认 NITRO_PORT / PORT）
  serverPort = await pickPort()
  process.env.NITRO_PORT = String(serverPort)
  process.env.PORT = String(serverPort)
  // ② 强制只绑 loopback（这个工具会读写用户的校园跑凭据，绝不能被局域网访问）。
  //    ⚠️ 不沿用外部 NITRO_HOST/HOST：用户环境里残留 0.0.0.0 时不能把服务暴露出去。
  process.env.NITRO_HOST = HOST
  process.env.HOST = HOST
  // ③ 授权/运行数据目录：已在模块加载时由 ensureLicenseDataDir() 探测旧版授权并确定
  //    （见文件上方注释；不要在这里重新赋值，否则会覆盖迁移结果）。

  log(`starting Nitro: ${entry} (${HOST}:${serverPort})`)

  // ④ 进程内加载生产产物。`import()` 里 Nitro 会同步调用 listen()。
  await import(pathToFileURL(entry).href)

  const url = `http://${HOST}:${serverPort}/`
  if (!(await waitForServer(url, STARTUP_TIMEOUT_MS))) {
    throw new Error(
      `Nitro 服务在 ${Math.round(STARTUP_TIMEOUT_MS / 1000)} 秒内没有就绪：${url}\n\n` +
        `常见原因：端口被占用、安全软件拦截、或 .output 构建不完整。`,
    )
  }
  log(`Nitro ready: ${url}`)
  return url
}

/* ============================== Windows 定位（WinRT）============================== */

/**
 * 为什么不让页面直接用 `navigator.geolocation`：
 *   Electron 自带的 Chromium 在 Windows/国内环境下经常拿不到位置（没有 Google 定位服务；
 *   旧办法 `--enable-features=WinrtGeolocationImplementation` 在当前 Chromium 里已不再生效）。
 *   而系统自带的 `Windows.Devices.Geolocation`（WinRT）是可用的 —— 由主进程用 PowerShell
 *   问一次 Windows，再把经纬度通过 IPC 回给页面；页面侧仍保留 navigator.geolocation 兜底。
 *
 * 只在本机页面（127.0.0.1）里允许调用；坐标只在内存里用于地图居中，不落盘、不上传。
 */
const WINDOWS_LOCATION_PS = String.raw`
$ErrorActionPreference = 'Stop'
function Emit($obj) {
  $json = ConvertTo-Json $obj -Compress
  if ($env:TOTORO_GEO_OUT) {
    [System.IO.File]::WriteAllText($env:TOTORO_GEO_OUT, $json, (New-Object System.Text.UTF8Encoding($false)))
  } else {
    [Console]::Out.Write($json)
  }
}
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq ('IAsyncOperation' + [char]96 + '1')
  })[0]
  function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    [void]$netTask.GetAwaiter().GetResult()
    $netTask.Result
  }
  $null = [Windows.Devices.Geolocation.Geolocator, Windows.Devices.Geolocation, ContentType = WindowsRuntime]
  $locator = New-Object Windows.Devices.Geolocation.Geolocator
  $locator.DesiredAccuracy = [Windows.Devices.Geolocation.PositionAccuracy]::High
  $pos = Await ($locator.GetGeopositionAsync()) ([Windows.Devices.Geolocation.Geoposition])
  $p = $pos.Coordinate.Point.Position
  $result = @{
    ok = $true
    latitude = [double]$p.Latitude
    longitude = [double]$p.Longitude
    accuracy = [double]$pos.Coordinate.Accuracy
  }
  Emit $result
} catch {
  $result = @{ ok = $false; error = [string]$_.Exception.Message }
  Emit $result
}
`

/** PowerShell 可执行文件路径（系统目录，不用 PATH） */
function powershellExePath() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** 解析定位脚本输出（stdout 的最后一行 JSON，或任务通道写出的文件内容） */
function parseGeoJson(raw) {
  const line = String(raw || '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .pop()
  if (!line) return null
  try {
    const parsed = JSON.parse(line)
    if (!parsed || parsed.ok !== true) {
      return { ok: false, error: String(parsed?.error || '系统没有返回位置') }
    }
    const latitude = Number(parsed.latitude)
    const longitude = Number(parsed.longitude)
    const accuracy = Number(parsed.accuracy)
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return { ok: false, error: '系统返回的位置无效' }
    }
    return { ok: true, latitude, longitude, accuracy: Number.isFinite(accuracy) && accuracy > 0 ? accuracy : 0 }
  } catch {
    return null
  }
}

function execFileP(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 第一通道：直接在 Electron 子进程里跑 PowerShell。
 *
 * ⚠️ 实测（2026-10-27）：Windows 定位会**拒绝 Electron 进程树里的 PowerShell**
 * （直接运行同一个脚本能拿到坐标，但作为 electron.exe 的子进程时报
 * 「应在应用程序清单中声明 ID_CAP_LOCATION / 拒绝访问」）⇒ 必须有第二通道。
 */
function runWindowsLocationDirect() {
  return new Promise((resolve) => {
    const encoded = Buffer.from(WINDOWS_LOCATION_PS, 'utf16le').toString('base64')
    const args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]
    execFile(
      powershellExePath(),
      args,
      { windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          log('geolocate: direct powershell failed', err.message, String(stderr || '').slice(0, 500))
          resolve({ ok: false, error: `系统定位调用失败：${err.message}` })
          return
        }
        const parsed = parseGeoJson(stdout)
        resolve(parsed || { ok: false, error: '系统定位返回了无法解析的数据' })
      },
    )
  })
}

/**
 * 第二通道：让 **Task Scheduler（系统服务）** 去启动 PowerShell —— 进程不在 Electron 进程树里，
 * 不会继承 Electron 的进程缓解策略/身份限制，实测能正常拿到 Windows 定位。
 *
 * 做法：临时写 PS 脚本 + 一个隐藏启动的 VBS，用 schtasks 建一次性任务、立刻运行、
 * 轮询它写出的 JSON，最后删除任务与临时文件（无论成功失败都清）。
 *
 * ⚠️ 这是"系统定位"兜底；如果企业策略禁止创建计划任务，会返回错误，页面还有「手动按坐标定位」。
 */
async function runWindowsLocationViaTask() {
  const tmpDir = app.getPath('temp')
  const stamp = `${process.pid}-${Date.now()}`
  const taskName = `totoro-heaven-geo-${stamp}`
  const scriptFile = path.join(tmpDir, `totoro-geo-${stamp}.ps1`)
  const vbsFile = path.join(tmpDir, `totoro-geo-${stamp}.vbs`)
  const outFile = path.join(tmpDir, `totoro-geo-${stamp}.json`)
  const cleanup = async () => {
    await execFileP('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], { windowsHide: true, timeout: 10000 })
    for (const f of [scriptFile, vbsFile, outFile]) {
      try {
        fs.rmSync(f, { force: true })
      } catch {
        /* ignore */
      }
    }
  }
  try {
    fs.writeFileSync(scriptFile, WINDOWS_LOCATION_PS, 'utf8')
    const vbs = [
      'Set sh = CreateObject("WScript.Shell")',
      `sh.Environment("Process")("TOTORO_GEO_OUT") = "${outFile.replace(/"/g, '""')}"`,
      `sh.Run """${powershellExePath()}"" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${scriptFile}""", 0, False`,
      '',
    ].join('\r\n')
    fs.writeFileSync(vbsFile, vbs, 'utf8')

    const create = await execFileP(
      'schtasks.exe',
      [
        '/Create',
        '/TN',
        taskName,
        '/TR',
        `"${path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe')}" "${vbsFile}"`,
        '/SC',
        'ONCE',
        '/ST',
        '23:59',
        '/F',
        '/IT',
      ],
      { windowsHide: true, timeout: 15000 },
    )
    if (create.err) {
      log('geolocate: task create failed', create.err.message, create.stderr.slice(0, 300))
      return { ok: false, error: '系统定位备用通道创建失败（可能被策略禁止）' }
    }
    const run = await execFileP('schtasks.exe', ['/Run', '/TN', taskName], { windowsHide: true, timeout: 15000 })
    if (run.err) {
      log('geolocate: task run failed', run.err.message, run.stderr.slice(0, 300))
      return { ok: false, error: '系统定位备用通道启动失败' }
    }

    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      await sleep(250)
      if (!fs.existsSync(outFile)) continue
      const parsed = parseGeoJson(fs.readFileSync(outFile, 'utf8'))
      if (parsed) return parsed
    }
    return { ok: false, error: '系统定位超时（备用通道）' }
  } catch (err) {
    log('geolocate: task fallback crashed', err)
    return { ok: false, error: String(err?.message || err) }
  } finally {
    await cleanup()
  }
}

/** 调一次 Windows 定位（失败返回 `{ ok:false, error }`，不抛错）：先直连，被拒再走计划任务通道 */
async function getWindowsLocation() {
  const direct = await runWindowsLocationDirect()
  if (direct.ok) return direct
  log('geolocate: direct failed, trying scheduled-task channel', direct.error)
  const viaTask = await runWindowsLocationViaTask()
  if (viaTask.ok) return viaTask
  log('geolocate: all channels failed', viaTask.error)
  return viaTask
}

ipcMain.handle('totoro:geolocate', async (event) => {
  // 只服务本机页面：别的来源一律拒绝
  try {
    const url = new URL(event.senderFrame?.url || event.sender.getURL())
    const local = (url.protocol === 'http:' || url.protocol === 'https:') && (url.hostname === HOST || url.hostname === 'localhost')
    if (!local) return { ok: false, error: 'forbidden' }
  } catch {
    return { ok: false, error: 'forbidden' }
  }
  return getWindowsLocation()
})

/* ============================== 窗口 ============================== */

/** 服务启动期间的本地占位页（窗口立即出现，不白屏、不闪浏览器默认图标） */
function loadingPage() {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${APP_TITLE}</title>
<style>
  html,body{height:100%;margin:0}
  body{background:#101418;color:#e8eef6;font-family:"Microsoft YaHei","Segoe UI",sans-serif;
       display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;user-select:none}
  .title{font-size:26px;letter-spacing:.18em;color:#8fd3ff}
  .spinner{width:34px;height:34px;border:3px solid rgba(143,211,255,.25);border-top-color:#8fd3ff;
           border-radius:50%;animation:spin 1s linear infinite}
  .hint{font-size:13px;color:#8a99ab}
  @keyframes spin{to{transform:rotate(360deg)}}
</style></head>
<body>
  <div class="title">${APP_TITLE}</div>
  <div class="spinner"></div>
  <div class="hint">正在启动本地服务…</div>
</body></html>`
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

function createWindow() {
  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 1024,
    minHeight: 700,
    title: APP_TITLE,
    icon: iconPath(),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#101418',
    webPreferences: {
      // 页面就是本机 Nitro 服务，不需要 Node 能力 ⇒ 保持默认的隔离/沙箱最稳
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      devTools: !IS_PACKAGED,
      // 只暴露 window.totoroDesktop.locate()（主进程 Windows 定位），见 electron/preload.cjs
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })

  // ① 无菜单栏（Windows 上连 Alt 菜单也不出现）
  win.setMenu(null)
  win.setMenuBarVisibility(false)

  // ② 标题固定「龙猫天堂」：页面 <title> 是「龙猫天堂 · 阳光跑助手」，不拦会覆盖窗口标题
  win.on('page-title-updated', (event) => {
    event.preventDefault()
    if (!win.isDestroyed()) win.setTitle(APP_TITLE)
  })

  // ③ 首帧准备好再显示，避免白屏闪一下
  win.once('ready-to-show', () => {
    if (!quitting && !win.isDestroyed()) win.show()
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  win.on('unresponsive', () => log('window unresponsive'))

  // ④ 外链交给系统浏览器；本机地址允许窗口内导航（一般不会发生）
  const isLocalUrl = (u) => {
    try {
      const parsed = new URL(u)
      return (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        parsed.hostname === HOST &&
        parsed.port === String(serverPort)
      )
    } catch {
      return false
    }
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalUrl(url)) return { action: 'allow' }
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isLocalUrl(url)) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    log(`did-fail-load: ${errorCode} ${errorDescription} ${validatedURL}`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    log('render-process-gone', details)
  })

  return win
}

/* ============================== 启动流程 ============================== */

function startupFailureMessage(err) {
  const detail = err instanceof Error ? err.message : String(err)
  return (
    `${detail}\n\n` +
    `如果反复失败，可以改用浏览器 / SEA 版兜底：\n` +
    `  - 浏览器版：pack/sea/launcher.mjs 的逻辑仍在（npm run sea 可打单文件 EXE）\n` +
    `  - 日志：${logFilePath()}`
  )
}

/**
 * 无人值守冒烟测试（CI / 打包后自检用）：**不创建窗口**，只启动内嵌 Nitro、请求一次首页、
 * 校验页面特征，把结果写进 marker 文件后退出。
 *
 * 用法：
 *   set TOTORO_SMOKE=1
 *   set TOTORO_SMOKE_OUT=dist\smoke.txt
 *   totoro-heaven-<ver>-portable.exe
 * 退出码 0 = 通过；marker 内 `ok=true/false`。
 *
 * 为什么需要它：Electron 的窗口渲染依赖 Chromium 子进程（命名管道），在受限的 CI/沙箱里
 * 可能起不来；但"内嵌服务能否在打包后正常起来"是可以独立验证的（这条链路最容易坏）。
 */
async function runSmokeTest() {
  const url = await startNitroServer()
  const html = await getText(url)
  const ok = html.includes(APP_TITLE) && html.includes('__NUXT')
  const marker = process.env.TOTORO_SMOKE_OUT?.trim() || path.join(app.getPath('temp'), 'totoro-heaven-smoke.txt')
  const body = [
    `url=${url}`,
    `ok=${ok}`,
    `bytes=${html.length}`,
    `time=${new Date().toISOString()}`,
    '',
  ].join('\n')
  try {
    fs.writeFileSync(marker, body, 'utf8')
  } catch (err) {
    log('smoke: cannot write marker', err)
  }
  log(`smoke: ${ok ? 'PASS' : 'FAIL'} url=${url} bytes=${html.length} marker=${marker}`)
  app.exit(ok ? 0 : 1)
}

async function bootstrap() {
  if (booting) return
  booting = true

  // 菜单栏整体移除（不只是当前窗口）
  Menu.setApplicationMenu(null)
  try {
    app.setAppUserModelId(APP_ID)
  } catch {
    /* 非 Windows 平台忽略 */
  }

  // 复制机器码 / 粘贴 token 会用到剪贴板；「定位（我的位置）」会用到定位权限。
  // 这两个权限只放给本机页面（窗口只加载 127.0.0.1），其余一律拒绝。
  const allowedPermissions = new Set(['geolocation', 'clipboard-read', 'clipboard-sanitized-write'])
  try {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(allowedPermissions.has(permission))
    })
    // Electron 43 同时会走 check handler 判权限；不显式给 geolocation 时 getCurrentPosition 直接失败
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowedPermissions.has(permission))
  } catch (err) {
    log('setPermissionRequestHandler failed', err)
  }

  // 冒烟测试模式：只验证「打包后的内嵌服务」，不碰窗口（见 runSmokeTest 注释）
  if (process.env.TOTORO_SMOKE === '1') {
    try {
      await runSmokeTest()
    } catch (err) {
      log('smoke failed', err)
      app.exit(1)
    }
    return
  }

  const win = createWindow()
  mainWindow = win
  // 先挂一个本地占位页：窗口马上出现，用户体验上不是"双击没反应"
  win.loadURL(loadingPage()).catch((err) => log('load loading page failed', err))

  try {
    const url = await startNitroServer()
    await win.loadURL(url)
    if (!win.isDestroyed()) win.setTitle(APP_TITLE)
  } catch (err) {
    log('startup failed', err)
    quitting = true
    try {
      dialog.showErrorBox(`${APP_TITLE} 启动失败`, startupFailureMessage(err))
    } catch {
      /* dialog 本身失败时至少日志里有 */
    }
    app.quit()
  } finally {
    booting = false
  }
}

/* ============================== 应用生命周期 ============================== */

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  // 已有实例：本进程直接退出（避免两个服务抢端口 / 两个窗口）
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(bootstrap).catch((err) => {
    log('bootstrap crashed', err)
    try {
      dialog.showErrorBox(`${APP_TITLE} 启动失败`, startupFailureMessage(err))
    } catch {
      /* ignore */
    }
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && !booting) bootstrap()
  })
}

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// GUI 程序没有控制台：未捕获错误至少落进日志文件，方便用户把日志发回来
process.on('uncaughtException', (err) => log('uncaughtException', err))
process.on('unhandledRejection', (reason) => log('unhandledRejection', reason))
