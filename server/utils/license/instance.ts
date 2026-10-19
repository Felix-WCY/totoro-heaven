/**
 * **本机身份**：数据目录、实例 ID、机器码。
 *
 * ## 🔴 为什么这里**不用** `RUNTIME_DIR`（`logger.ts` 的 `%TEMP%\totoro-heaven-runtime`）
 * 仓库里日志 / 抓包存档都放 `%TEMP%` —— 那是**可丢弃**的运行数据，被清掉无所谓。
 * 但**许可证不是**：`%TEMP%` 会被 Windows 磁盘清理、安全软件、`cleanmgr` 清空，
 * 一旦授权文件随临时目录消失，用户会在**毫无预兆**的情况下突然"未授权"。
 * ⇒ 授权数据放**每用户持久目录** `%LOCALAPPDATA%\totoro-heaven`。
 *
 * ## 🆕 2026-10-19：**多候选目录**（读优先原处、写自动找可写处）
 * 实测故障：某些机器上 `%LOCALAPPDATA%` 与 `%TEMP%` 对程序**都不可写**（EPERM）。
 * 杀软过滤驱动、Windows「受控文件夹访问」、企业策略、沙箱都能造成。原实现只认一个目录，
 * 于是：① `instance-id` 落不了盘 ⇒ 机器码**每次运行都变**、证书永远对不上；
 * ② 激活时写 `license.json` 直接失败。
 *
 * 现在把两件事**拆开**：
 * - **读**：按候选顺序找**已经存在**的 `instance-id` / `license.json` —— 只要以前写成功过，
 *   机器码就**保持不变**（这一条很关键：不能让"换目录"把已发出的证书作废）；
 * - **写**：按候选顺序找第一个**真正可写**的目录（写探针文件验证，不靠猜）。
 *
 * 候选优先级：`TOTORO_LICENSE_DIR`（显式覆盖，测试用）→ `%LOCALAPPDATA%\totoro-heaven`
 * → `%APPDATA%\totoro-heaven` → `TOTORO_DATA_DIR`（由启动器传入、通常是 EXE 旁边）
 * → `~/.totoro-heaven`。
 *
 * ## 机器码怎么算（为什么是这三样）
 * ```
 * sha256('totoro-license-v1' | 实例ID | platform | arch) 的前 16 位 hex
 * ```
 * - **实例 ID**：首次运行随机生成（UUID）、落盘持久化。它是"这台机器上的这个安装"的身份，
 *   也是防"把证书文件拷给同学"的主力 —— 对方机器上的实例 ID 不同 ⇒ 指纹对不上。
 * - **platform / arch**：与实例 ID 一起哈希，换操作系统/换架构（x64→arm64）后指纹变化。
 * - ❌ **故意不含** `hostname` / CPU 型号 / 内存大小：这些用户改个计算机名、加条内存就会变，
 *   会造成"什么都没干授权就没了"的客服灾难。稳定性优先。
 *
 * ⚠️ 已知边界（如实记录，不粉饰）：把 `license.json` **和** `instance-id` 两个文件一起拷到别的机器，
 *    指纹还是对得上的（因为指纹由这两个文件推出）。要根治必须引入服务端在线校验。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { arch, homedir, platform } from 'node:os'
import { join } from 'node:path'
import { formatMachineCode, MACHINE_CODE_HEX_LEN } from './certificate'

/** 指纹哈希前缀：将来改口径时递增，老指纹自然失效（比"悄悄算错"可控） */
const FINGERPRINT_SALT = 'totoro-license-v1'

/** 实例 ID 的合法形状（UUID v4；用正则卡住，防止文件被写坏后一直算出不同的机器码） */
const INSTANCE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 实例 ID 文件名 / 授权文件名（两个都只在这一个模块里拼，避免口径分叉） */
const INSTANCE_ID_NAME = 'instance-id'
const LICENSE_FILE_NAME = 'license.json'

/** 环境变量显式覆盖（测试用）：设了就**只用它**，保持原有单目录语义 */
const ENV_OVERRIDE = process.env.TOTORO_LICENSE_DIR?.trim()

/**
 * 授权数据目录候选（按优先级）。读文件时按顺序找**已存在**的；写文件时用第一个**可写**的。
 * 见文件头的「多候选目录」说明。
 */
export const LICENSE_DIR_CANDIDATES: string[] = (
  ENV_OVERRIDE
    ? [ENV_OVERRIDE]
    : [
        join(process.env.LOCALAPPDATA?.trim() || homedir(), 'totoro-heaven'),
        ...(process.env.APPDATA?.trim() ? [join(process.env.APPDATA.trim(), 'totoro-heaven')] : []),
        ...(process.env.TOTORO_DATA_DIR?.trim() ? [process.env.TOTORO_DATA_DIR.trim()] : []),
        join(homedir(), '.totoro-heaven'),
      ]
).filter((d) => Boolean(d))

/** 在候选目录里找某个文件，返回第一个**存在**的完整路径（找不到返回 `null`） */
function findExisting(name: string): string | null {
  for (const dir of LICENSE_DIR_CANDIDATES) {
    try {
      const p = join(dir, name)
      if (existsSync(p)) return p
    } catch {
      // 这个候选读不了（权限/路径异常）⇒ 试下一个，不影响其它候选
    }
  }
  return null
}

/**
 * 目录**真的可写吗**：写一个探针文件再删掉，不靠猜（`existsSync` 只能说明目录在，
 * 说明不了能不能写 —— 这次故障正是"目录在、但写进去 EPERM"）。
 */
function isDirWritable(dir: string): boolean {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const probe = join(dir, `.write-probe-${process.pid}`)
    writeFileSync(probe, 'ok')
    rmSync(probe, { force: true })
    return true
  } catch {
    // 不可写（EPERM / 只读 / 磁盘满）⇒ 由调用方换下一个候选
    return false
  }
}

/** 第一个**可写**的目录（写 `license.json` / 新建 `instance-id` 用）；全不可写返回 `null` */
export function writableLicenseDir(): string | null {
  for (const dir of LICENSE_DIR_CANDIDATES) {
    if (isDirWritable(dir)) return dir
  }
  return null
}

/** 已存在的授权文件路径（只读查找，找不到返回 `null`）—— `state.ts` 读状态时用这个 */
export function existingLicenseFile(): string | null {
  return findExisting(LICENSE_FILE_NAME)
}

/**
 * 给界面显示的「授权数据目录」：优先已存在文件的所在目录，否则第一个候选。
 * ⚠️ 只用于展示与排查，**不要**拿它去拼要读写的文件路径（读写各自有自己的查找逻辑）。
 */
export function displayLicenseDir(): string {
  const lic = existingLicenseFile()
  if (lic) return lic.slice(0, lic.length - LICENSE_FILE_NAME.length - 1)
  const iid = findExisting(INSTANCE_ID_NAME)
  if (iid) return iid.slice(0, iid.length - INSTANCE_ID_NAME.length - 1)
  return LICENSE_DIR_CANDIDATES[0] ?? ''
}

/**
 * 授权文件"应该"在哪：优先**已存在**的，其次第一个**可写**目录，最后第一个候选。
 * 只用于展示 / 诊断 / 单测断言；真正写入由 `writeLicenseFile()` 决定。
 */
export function preferredLicenseFile(): string {
  const existing = existingLicenseFile()
  if (existing) return existing
  const dir = writableLicenseDir() ?? LICENSE_DIR_CANDIDATES[0] ?? ''
  return join(dir, LICENSE_FILE_NAME)
}

/**
 * 把授权文件写到**第一个可写**目录。
 * @returns 成功时给实际落盘路径；失败给**能照做的**原因（而不是让调用方去拼路径）
 */
export function writeLicenseFile(contents: string): { ok: true; path: string } | { ok: false; error: string } {
  const dir = writableLicenseDir()
  if (!dir) {
    return {
      ok: false,
      error: '找不到可写入的目录（已依次尝试 %LOCALAPPDATA%、%APPDATA%、程序目录、用户主目录）',
    }
  }
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const p = join(dir, LICENSE_FILE_NAME)
    writeFileSync(p, contents, 'utf8')
    return { ok: true, path: p }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 删除授权文件（幂等）。@returns 是否真的删掉了一个已存在的文件 */
export function removeLicenseFile(): boolean {
  const existing = existingLicenseFile()
  if (!existing) return false
  try {
    rmSync(existing, { force: true })
    return true
  } catch {
    // 删不掉（被占用/权限）：调用方会按"仍然有证书"如实反映，这里只回报失败
    return false
  }
}

/** 进程内缓存：同一进程里机器码是常量，不必每次读盘 */
let cachedInstanceId: string | null = null

/**
 * 取本机实例 ID。
 *
 * ① 先在所有候选目录里找**已有**的 `instance-id` —— 找到就复用它（保证机器码稳定）；
 * ② 都没有才生成新的，写到**第一个可写**目录。
 *
 * @returns `id` 实例 ID；`persisted` 是否已落盘（false = 下次运行会变，界面**必须**提示）
 */
export function getInstanceId(): { id: string; persisted: boolean } {
  if (cachedInstanceId) return { id: cachedInstanceId, persisted: true }

  // ① 复用已有的（**读**优先，保住机器码 —— 换目录不能让已发出的证书作废）
  for (const dir of LICENSE_DIR_CANDIDATES) {
    try {
      const p = join(dir, INSTANCE_ID_NAME)
      if (!existsSync(p)) continue
      const text = readFileSync(p, 'utf8').trim()
      if (INSTANCE_ID_RE.test(text)) {
        cachedInstanceId = text.toLowerCase()
        return { id: cachedInstanceId, persisted: true }
      }
      // 文件在但内容坏了（写了一半/被手工改过）⇒ 当它不存在，继续找下一个候选
    } catch {
      // 这个候选读失败（权限/被占用）⇒ 试下一个
    }
  }

  // ② 生成新的，写到第一个可写目录
  const fresh = randomUUID()
  cachedInstanceId = fresh
  for (const dir of LICENSE_DIR_CANDIDATES) {
    if (!isDirWritable(dir)) continue
    try {
      writeFileSync(join(dir, INSTANCE_ID_NAME), `${fresh}\n`, 'utf8')
      return { id: fresh, persisted: true }
    } catch {
      // 写失败 ⇒ 试下一个候选
    }
  }
  // 全部不可写：本次运行仍可用（id 在内存里），但**下次机器码会变** ⇒ 由 persisted=false 上报
  return { id: fresh, persisted: false }
}

/**
 * 本机机器指纹（16 位小写 hex）—— 证书里的 `fp` 必须等于它。
 * 纯计算 + 一次读盘（首次）；运行期调用**零额外开销**（实例 ID 已缓存）。
 */
export function machineFingerprint(): string {
  const { id } = getInstanceId()
  return createHash('sha256')
    .update([FINGERPRINT_SALT, id, platform(), arch()].join('|'))
    .digest('hex')
    .slice(0, MACHINE_CODE_HEX_LEN)
}

/** 显示用机器码（`A1B2-C3D4-E5F6-7890`）—— 用户念给供应商、或供应商签发时粘贴的那一串 */
export function machineCode(): string {
  return formatMachineCode(machineFingerprint())
}
