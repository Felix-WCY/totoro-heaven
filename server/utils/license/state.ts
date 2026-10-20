/**
 * 授权**状态层**：读盘 / 验签 / 缓存 / 激活 / 解绑。
 *
 * ## 性能口径（用户明确担心"服务器配置不行"）
 * 验签是**本机纯 CPU 运算**（Ed25519 验签约 50 微秒），**不联网、不请求任何服务**。
 * 而且结果**缓存 5 分钟**：普通业务请求只做一次内存判断，运行期开销可忽略。
 * ⚠️ 绝对不要改成"每个请求去远程验证"——那既拖垮弱机器，又直接违背"之后要能离线用"。
 *
 * ## 缓存 TTL 为什么是 5 分钟
 * 缓存太长 ⇒ 用户在界面上点了"激活"却要等很久才生效；太短 ⇒ 白白重算。
 * 另外到期这件事也靠它兜底：`exp` 过去后最多 5 分钟就会被发现并降级。
 * **激活/解绑成功时会主动清缓存**（见 `activateLicense`），所以用户操作是**立即生效**的。
 *
 * ## dev 绕过（为什么必须有）
 * 开发时 `npm run dev` 跑的是**源码**，还没有证书、也不该为了调试去签一张真证书。
 * 所以 dev（`import.meta.dev`，Nitro 在构建期烘焙的常量）下**默认放行**，并在界面上打出醒目提示。
 * 生产构建（`npm run build` → 打包 EXE）里 `import.meta.dev === false` ⇒ **强制校验**。
 * 想在本机按生产口径自测，设 `TOTORO_LICENSE_STRICT=1` 即可强制开启校验。
 */
import { readFileSync } from 'node:fs'
import { logInfo, logWarn } from '../logger'
import { decodeCertificate, verifyCertificate } from './certificate'
import type { LicenseCode, LicensePayload } from './certificate'
import {
  displayLicenseDir,
  existingLicenseFile,
  getInstanceId,
  machineCode,
  machineFingerprint,
  preferredLicenseFile,
  readSidecar,
  removeLicenseFile,
  writeLicenseFile,
  writeSidecar,
} from './instance'
import { checkClock, describeRollback, type ClockCheckResult } from '../../../utils/mp/clockGuard'
import { LICENSE_PUBLIC_KEY_PEM } from './publicKey'

/**
 * 状态码 = 证书判定码 + 一个"还没激活"。
 * 之所以不塞进 `certificate.ts`：那边是**纯证书判定**（证书在手上才有话说），
 * "用户还没粘证书"是本层的概念，混进去会让纯函数层多一个它不该知道的状态。
 */
export type LicenseStatusCode = LicenseCode | 'not_activated'

export const LICENSE_STATUS_TEXT: Record<LicenseStatusCode, string> = {
  ok: '授权有效',
  not_activated: '未激活（请粘贴供应商发给你的授权证书）',
  no_public_key: '本程序未配置许可证公钥（供应商尚未执行 tools/license-keygen.ts）',
  malformed: '证书格式不正确（复制时可能漏字或被截断，请整段粘贴）',
  bad_signature: '证书签名无效（内容被篡改，或不是本程序的供应商签发）',
  fingerprint_mismatch: '证书与本机机器码不匹配（这是发给另一台机器的证书）',
  grace_expired: '授权已过期（且已超出离线宽限期）',
  clock_rollback: '检测到系统时间被调回（授权按累计使用时间判定）—— 请把系统时间校准到正确时间后重试',
}

/** 落盘结构（**不含任何秘密**：证书本身是签名产物，公开保存也无害） */
interface LicenseFileShape {
  v: number
  /** 供应商签发的证书原文 */
  certificate: string
  /** 激活当时的机器码（换机器后与当前机器码不一致时，便于排查） */
  machineCode: string
  /** 激活时间（ISO） */
  activatedAt: string
}

export interface LicenseStatus {
  /** 是否**可以放行**（= 证书有效，或处于 dev 绕过） */
  licensed: boolean
  /** 证书判定的真实结论（**不含** dev 绕过；即使绕过，这里仍是 `not_activated` 之类） */
  code: LicenseStatusCode
  /** 已过 `exp` 但仍在宽限期 ⇒ 界面要提示"请尽快续期" */
  degraded: boolean
  /** 面向用户的一句话说明 */
  message: string
  /** 本机机器码（显示形式，用户拿去申请授权） */
  machineCode: string
  /** 机器码是否已**持久化**；false = 下次运行会变，授权将失效（必须提示用户） */
  machineCodeStable: boolean
  /** 供应商是否已配置公钥；false = 本程序还没配好，任何证书都通不过 */
  publicKeyConfigured: boolean
  /** 是否因为"开发模式"而放行（生产构建恒为 false） */
  devBypass: boolean
  /** 当前是否按生产口径强制校验 */
  enforced: boolean
  /** 授权对象（客户名 / 备注） */
  subject: string
  /** 许可证编号 */
  licenseId: string
  /** 功能位 */
  features: string[]
  /** 签发时间（Unix 秒；0 = 无） */
  issuedAt: number
  /** 正常到期（Unix 秒；0 = 无） */
  expiresAt: number
  /** 离线宽限硬上限（Unix 秒；0 = 无） */
  graceUntil: number
  /** 激活时间（ISO；'' = 未激活） */
  activatedAt: string
  /** 授权数据目录（排查用） */
  dir: string
}

/** dev 判定：Nitro 构建期烘焙的常量。用显式断言读，避免 tsconfig.mp 下 `import.meta.dev` 无类型定义报错。 */
const IS_DEV = Boolean((import.meta as unknown as { dev?: boolean }).dev)

/** 强制在生产口径下校验（本机自测用：`set TOTORO_LICENSE_STRICT=1`） */
export const LICENSE_STRICT = process.env.TOTORO_LICENSE_STRICT === '1'

/** 是否处于"强制校验"口径：生产构建恒为 true；dev 下默认 false，除非显式 strict */
export const LICENSE_ENFORCED = !IS_DEV || LICENSE_STRICT

/** 结果缓存 TTL：5 分钟（理由见文件头） */
const CACHE_TTL_MS = 5 * 60 * 1000

let cached: { status: LicenseStatus; at: number } | null = null

/** 上一次已记录的判定码：只在**变化**时写日志，避免每 5 分钟刷一条相同记录 */
let lastLoggedCode: LicenseStatusCode | null = null

/** 读盘（坏文件/读失败一律当作"未激活"，**不抛异常**——授权状态坏了不该让整个程序起不来） */
function readLicenseFile(): LicenseFileShape | null {
  try {
    // 🆕 多候选目录：在**所有**候选里找已存在的授权文件（换过目录也能读到）
    const file = existingLicenseFile()
    if (!file) return null
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const o = parsed as Partial<LicenseFileShape>
    if (typeof o.certificate !== 'string' || !o.certificate) return null
    return {
      v: Number(o.v ?? 1),
      certificate: o.certificate,
      machineCode: String(o.machineCode ?? ''),
      activatedAt: String(o.activatedAt ?? ''),
    }
  } catch {
    // 文件损坏 / 权限不足：按"未激活"处理。宁可要求重新激活，也不要因为一个坏文件让服务起不来
    return null
  }
}

/** 组装状态所需的"已判定"输入（把 `LicenseCheck` 与"还没激活"两种来源统一成一种形状） */
interface StatusInput {
  code: LicenseStatusCode
  /** 是否通过证书校验（"未激活"恒为 false） */
  ok: boolean
  degraded: boolean
  message: string
  payload: LicensePayload | null
}

/** 由"已判定的输入"组装完整状态（纯函数，便于测试与排查） */
function buildStatus(input: StatusInput, activatedAt: string): LicenseStatus {
  const payload: LicensePayload | null = input.payload
  const { persisted } = getInstanceId()
  return {
    // ⚠️ `licensed` 只由证书决定；dev 绕过在 middleware 里另外判断（这里如实反映真实授权状态）
    licensed: input.ok,
    code: input.code,
    degraded: input.degraded,
    message: input.message,
    machineCode: machineCode(),
    machineCodeStable: persisted,
    publicKeyConfigured: Boolean(LICENSE_PUBLIC_KEY_PEM.trim()),
    devBypass: !LICENSE_ENFORCED,
    enforced: LICENSE_ENFORCED,
    subject: payload?.sub ?? '',
    licenseId: payload?.lic ?? '',
    features: payload?.feat ?? [],
    issuedAt: payload?.iat ?? 0,
    expiresAt: payload?.exp ?? 0,
    graceUntil: payload?.grace ?? 0,
    activatedAt,
    dir: displayLicenseDir(),
  }
}

/**
 * 真正算一次状态（读盘 + 验签 + 组装 + 变化时记日志）
 *
 * ⚠️ "**还没激活**"是一条**独立状态**，绝不能借用 `malformed`（"证书格式不正确"）来占位 ——
 * 那样界面会对着一个只是还没粘证书的用户说"你的证书格式不对"，把人引到完全错误的方向。
 * （本文件第一版正是这么写的，被 `tests/mp/licenseState.test.ts` 抓出来 ⇒ 现在显式给 `not_activated`。）
 */
/** 时钟状态文件名：与 `license.json` 放同一批候选目录（删它就得连授权一起删） */
const CLOCK_STATE_NAME = 'last-seen.json'

/** 读「历史见过的最大时间」；没有/损坏都按 `0`（首次运行）处理，绝不抛异常 */
function readClockState(): { lastSeenMs: number } {
  const raw = readSidecar(CLOCK_STATE_NAME)
  if (!raw) return { lastSeenMs: 0 }
  try {
    const parsed = JSON.parse(raw) as { at?: unknown }
    const at = Number(parsed.at)
    return { lastSeenMs: Number.isFinite(at) && at > 0 ? at : 0 }
  } catch {
    // 文件写坏了：当作首次运行（宁可少记一次，也不要让程序起不来）
    return { lastSeenMs: 0 }
  }
}

/** 需要时把累计时间写回（只增不减；写不进去不影响本次判定，只是下次少一层保护） */
function persistClockState(result: ClockCheckResult): void {
  if (!result.shouldPersist) return
  writeSidecar(CLOCK_STATE_NAME, JSON.stringify({ at: result.effectiveNowMs, updatedAt: new Date().toISOString() }))
}

function computeStatus(): LicenseStatus {
  const file = readLicenseFile()
  let status: LicenseStatus
  if (!file) {
    status = buildStatus(
      { code: 'not_activated', ok: false, degraded: false, message: LICENSE_STATUS_TEXT.not_activated, payload: null },
      '',
    )
  } else {
    /**
     * **时钟回拨检测**（2026-10-20 补的洞）：
     * 到期判断用的是买家**本地时钟** —— 把系统时间调回购买那天，证书就永远不过期。
     * 两道防线：① 回拨超过 24 小时 ⇒ 判定为改时间，强制拒用；
     *          ② 判定有效期用 `max(当前, 历史最大)` ⇒ 累计时间只增不减，调回去白搭。
     */
    const clockCheck = checkClock({ nowMs: Date.now(), lastSeenMs: readClockState().lastSeenMs })
    persistClockState(clockCheck)
    if (!clockCheck.ok) {
      logWarn('license', '检测到系统时间被回拨，拒绝使用', { rollback: describeRollback(clockCheck.rollbackMs) })
      status = buildStatus(
        {
          code: 'clock_rollback',
          ok: false,
          degraded: false,
          message: `检测到系统时间被调回${describeRollback(clockCheck.rollbackMs)}（授权按累计使用时间判定）—— 请把系统时间校准到正确时间后重试`,
          payload: decodeCertificate(file.certificate),
        },
        file.activatedAt,
      )
    } else {
      const check = verifyCertificate(file.certificate, LICENSE_PUBLIC_KEY_PEM, {
        fingerprint: machineFingerprint(),
        nowMs: clockCheck.effectiveNowMs,
      })
      status = buildStatus(
        {
          code: check.code,
          ok: check.ok,
          degraded: check.ok && check.degraded,
          message: check.ok
            ? check.degraded
              ? '授权已到期但在离线宽限期内，请尽快续期'
              : LICENSE_STATUS_TEXT.ok
            : check.message,
          payload: check.payload,
        },
        file.activatedAt,
      )
      /**
       * 证书里的机器码与"激活时记录的机器码"不一致 ⇒ 说明用户在**别的机器上激活过之后把文件搬过来了**。
       * 这种情况 `verifyCertificate` 会以 `fingerprint_mismatch` 拒掉，这里只补一条更好排查的日志。
       */
      if (!check.ok && file.machineCode && file.machineCode !== status.machineCode) {
        logWarn('license', '授权文件的激活机器码与本机不一致', { from: file.machineCode, now: status.machineCode })
      }
    }
  }
  if (lastLoggedCode !== status.code) {
    lastLoggedCode = status.code
    /**
     * ⚠️ 这里判的是 `licensed`（证书是否有效），**不是** `ok` —— `LicenseStatus` 上根本没有 `ok` 字段。
     * 第一版误写成 `status.ok`：它恒为 `undefined`（假），于是**已授权用户也会被记成"校验未通过"**，
     * 而且运行期完全不报错（单测也抓不到，因为日志分支不影响返回值）—— 是 `npm run typecheck:mp` 抓出来的。
     */
    if (status.licensed) {
      logInfo('license', '授权校验通过', { subject: status.subject, expiresAt: status.expiresAt, degraded: status.degraded })
    } else {
      logWarn('license', `授权校验未通过：${status.code}`, { message: status.message })
    }
  }
  return status
}

/**
 * 取授权状态。**这是全程序读授权的唯一入口**（中间件、界面接口都用它）。
 * @param force 跳过缓存强制重算（激活/解绑后、以及诊断用）
 */
export function getLicenseStatus(force = false): LicenseStatus {
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.status
  const status = computeStatus()
  cached = { status, at: Date.now() }
  return status
}

/** 清缓存（内部用；激活/解绑/手工校验后调用） */
function invalidate(): void {
  cached = null
}

export interface ActivateResult {
  ok: boolean
  status: LicenseStatus
  /** 失败原因（面向用户；成功时为空串） */
  error: string
}

/**
 * 激活：校验证书并落盘。**失败绝不写盘**（否则会把一张坏证书持久化，之后一直报错还难排查）。
 * 成功时主动清缓存 ⇒ 界面点完立刻生效（不用等 5 分钟）。
 */
export function activateLicense(certificate: string): ActivateResult {
  const cert = String(certificate ?? '').trim()
  if (!cert) {
    return { ok: false, status: getLicenseStatus(true), error: '请先粘贴授权证书' }
  }
  if (!LICENSE_PUBLIC_KEY_PEM.trim()) {
    logWarn('license', '激活被拒：本程序未配置许可证公钥')
    return { ok: false, status: getLicenseStatus(true), error: LICENSE_STATUS_TEXT.no_public_key }
  }
  const check = verifyCertificate(cert, LICENSE_PUBLIC_KEY_PEM, { fingerprint: machineFingerprint() })
  if (!check.ok) {
    logWarn('license', `激活被拒：${check.code}`, { message: check.message })
    return { ok: false, status: getLicenseStatus(true), error: check.message }
  }
  const record: LicenseFileShape = {
    v: 1,
    certificate: cert,
    machineCode: machineCode(),
    activatedAt: new Date().toISOString(),
  }
  /**
   * 🆕 多候选目录：写到**第一个可写**目录。
   * `%LOCALAPPDATA%` 被拒（EPERM）时会自动换到 `%APPDATA%` / 程序目录 / 用户主目录 ——
   * 这是实测故障（2026-10-19）的正解：原先只认一个目录，写不进去就永远激活不了。
   */
  const written = writeLicenseFile(JSON.stringify(record, null, 2))
  if (!written.ok) {
    logWarn('license', '授权文件写入失败', { error: written.error })
    return {
      ok: false,
      status: getLicenseStatus(true),
      error: `授权文件写入失败：${written.error}。请把程序所在文件夹加入杀毒软件白名单，或右键「以管理员身份运行」。`,
    }
  }
  invalidate()
  lastLoggedCode = null
  logInfo('license', '激活成功', { subject: check.payload?.sub, licenseId: check.payload?.lic, expiresAt: check.payload?.exp })
  return { ok: true, status: getLicenseStatus(true), error: '' }
}

/** 解绑：删掉本机授权文件（换机/重装前用得上）。找不到文件也算成功（幂等）。 */
export function deactivateLicense(): LicenseStatus {
  // 🆕 多候选目录：删掉**任意候选里**已存在的授权文件
  const had = existingLicenseFile() !== null
  const removed = removeLicenseFile()
  if (!had) logInfo('license', '解绑：本机本来就没有授权文件')
  else if (removed) logInfo('license', '已解绑本机授权')
  else logWarn('license', '解绑失败（授权文件删不掉）')
  invalidate()
  lastLoggedCode = null
  return getLicenseStatus(true)
}

/** 供诊断/单测：授权文件的落盘路径 */
export const licenseFilePath = (): string => preferredLicenseFile()
