/**
 * electron-builder 的 `nsis.include` 只对**安装器**生效，portable 目标走的是 `portable.nsi` 模板，
 * 自定义 include 会被忽略（见 app-builder-lib/out/targets/nsis/NsisTarget.js 的 `if (!this.isPortable)`）。
 *
 * 这个脚本在打包前给 `node_modules/app-builder-lib/templates/nsis/portable.nsi` 打一个小补丁：
 * 在 `ExecWait` 启动内层 Electron 之前设置 `ELECTRON_DISABLE_SANDBOX=1`。
 *
 * 为什么必须关 Chromium 沙箱（2026-10-27 实测，本机 Windows 11 26H2）：
 *   - 原版 Electron 43/44/45 的浏览器进程在此环境下创建沙箱 IPC 失败，启动即 `STATUS_BREAKPOINT`
 *     (0x80000003)，表现为“双击没反应 / 窗口一闪而过”；
 *   - `--no-sandbox` 或 `ELECTRON_DISABLE_SANDBOX=1` 时正常出窗口（本会话已用最小 Electron 应用验证）；
 *   - 本应用窗口只加载自己的 `http://127.0.0.1:<port>/` 页面，关闭该沙箱是可接受的兼容取舍。
 *
 * 幂等：已打过补丁就跳过；找不到模板行则直接报错（不要静默打出一个没修好的包）。
 */
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..', '..')
const template = path.join(root, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'portable.nsi')

if (!fs.existsSync(template)) {
  console.error(`[patch] portable.nsi not found: ${template}`)
  process.exit(1)
}

let source = fs.readFileSync(template, 'utf8')

if (source.includes('ELECTRON_DISABLE_SANDBOX')) {
  console.log('[patch] portable.nsi already patched (ELECTRON_DISABLE_SANDBOX)')
  process.exit(0)
}

const lines = source.split(/\r?\n/)
const execWaitIndex = lines.findIndex((line) => line.includes('ExecWait "$INSTDIR\\${APP_EXECUTABLE_FILENAME}'))
if (execWaitIndex < 0) {
  console.error('[patch] cannot find the ExecWait line in portable.nsi - electron-builder layout changed?')
  process.exit(1)
}

const injection = [
  '  ; --- totoro-heaven: choose a writable profile + disable Chromium sandbox before launch ---',
  '  ; Chromium cannot start when userData (default %APPDATA%\\productName) is not writable, and on',
  '  ; some Windows 11 26H2 / hardened setups its sandbox IPC creation fails at startup. Both were',
  '  ; measured on this machine (2026-10-27); the app only loads its own http://127.0.0.1 page.',
  '  StrCpy $R9 "$APPDATA\\龙猫天堂"',
  '  CreateDirectory "$R9"',
  '  FileOpen $8 "$R9\\.write-probe" w',
  '  IfErrors 0 totoroProfileOK',
  '    StrCpy $R9 "$TEMP\\龙猫天堂-electron"',
  '    CreateDirectory "$R9"',
  '    Goto totoroProfileDone',
  '  totoroProfileOK:',
  '    FileWrite $8 "ok"',
  '    FileClose $8',
  '    Delete "$R9\\.write-probe"',
  '  totoroProfileDone:',
  "  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i (\"ELECTRON_DISABLE_SANDBOX\", \"1\").r0'",
  '',
]
lines.splice(execWaitIndex, 0, ...injection)

// Launch with the selected profile so Chromium never falls back to the unwritable default.
const execWaitLine = lines.findIndex((line) => line.includes('ExecWait "$INSTDIR\\${APP_EXECUTABLE_FILENAME}'))
lines[execWaitLine] = '\tExecWait \'"$INSTDIR\\${APP_EXECUTABLE_FILENAME}" --user-data-dir="$R9" $R0\' $0'

fs.writeFileSync(template, lines.join('\n'), 'utf8')
console.log(`[patch] portable.nsi patched (writable profile + ELECTRON_DISABLE_SANDBOX)`)
