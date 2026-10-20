/**
 * 许可证证书的**纯逻辑层**：编码 / 解析 / 验签 / 有效期与设备绑定判定。
 *
 * ## 证书长什么样（`<base64url(payload)>.<base64url(Ed25519 签名)>`）
 * ```json
 * { "v":1, "lic":"TH-...", "sub":"张三", "fp":"a1b2c3d4e5f60718",
 *   "feat":["pro"], "iat":1750000000, "exp":1780000000, "grace":1781000000 }
 * ```
 *
 * ## 为什么是**非对称签名**而不是「内置 key 白名单」
 * 白名单会被反编译直接读出来（甚至能反推出规则），对称加密更糟 —— 客户端能验签就说明它握着密钥。
 * 这里客户端**只嵌公钥**：公钥泄露无害（伪造不了签名），私钥永远只在供应商本机。
 * 于是「删掉校验代码」仍可能（客户端代码在用户机器上），但「伪造一张合法证书」在数学上不可行。
 *
 * ## 三条判定，缺一不可
 *  ① **验签**：没有私钥就绝对签不出来；
 *  ② **设备指纹**：`fp` 必须等于本机指纹 —— 挡住"把证书文件拷给同学"；
 *  ③ **有效期 + 离线宽限**：`exp` 内正常；`exp`~`grace` 之间**降级放行**（`degraded: true`）；
 *     过了 `grace` 硬停。这样"首次激活联网、之后离线"才能成立（详见 `state.ts`）。
 *
 * ⚠️ 本文件必须**保持纯函数**：不碰文件系统、不碰进程环境、不 import Nuxt/h3 自动导入项，
 *    这样 `tests/mp/licenseCertificate.test.ts` 能离线跑、`tsconfig.mp.json` 也能直接检查。
 */
import { createPublicKey, sign, verify } from 'node:crypto'

/** 证书载荷版本号。将来改字段含义时递增，老的证书会被判 `malformed`（宁拒绝不误放行）。 */
export const LICENSE_CERT_VERSION = 1

/** 允许的时钟偏差（秒）：签发方与使用方时钟不可能完全一致，1 天足够宽容且不影响安全。 */
export const LICENSE_CLOCK_SKEW_S = 24 * 60 * 60

/** 机器码的十六进制长度（8 字节 = 64 bit；这个量级不会碰撞，也够短好念）。 */
export const MACHINE_CODE_HEX_LEN = 16

/** 证书载荷（明文字段，**不含任何秘密**：字段本身公开，靠签名保证不可篡改）。 */
export interface LicensePayload {
  /** 载荷版本（当前恒为 1） */
  v: number
  /** 许可证编号（供应商内部记账用，非秘密） */
  lic: string
  /** 授权对象（客户名 / 备注） */
  sub: string
  /** **绑定的机器指纹**（16 位小写 hex）—— 换机器即失效 */
  fp: string
  /** 功能位（预留：`pro` / `export` …；本版只做记录与展示） */
  feat: string[]
  /** 签发时间（Unix 秒） */
  iat: number
  /** 正常到期时间（Unix 秒） */
  exp: number
  /** **离线宽限**硬上限（Unix 秒）：超过它一律拒绝，无论是否联网 */
  grace: number
}

/**
 * 判定结果码。
 * - `ok`：通过（可能 `degraded`）
 * - `no_public_key`：**供应商还没跑 keygen** ⇒ 拒绝一切（fail closed，绝不"放行"）
 * - `malformed`：格式/字段不合法
 * - `bad_signature`：签名对不上（篡改或伪造）
 * - `fingerprint_mismatch`：证书不是发给这台机器的
 * - `grace_expired`：连离线宽限都过了
 * - `clock_rollback`：检测到系统时间被往回拨（由 `state.ts` 判定，见 `utils/mp/clockGuard.ts`）
 */
export type LicenseCode =
  | 'ok'
  | 'no_public_key'
  | 'malformed'
  | 'bad_signature'
  | 'fingerprint_mismatch'
  | 'grace_expired'
  | 'clock_rollback'

export interface LicenseCheck {
  /** 是否放行 */
  ok: boolean
  code: LicenseCode
  /** 已过 `exp` 但仍在宽限期 ⇒ 应降级运行（界面要标出来，便于提示用户续期） */
  degraded: boolean
  /** 解析出来的载荷（即使验签失败、只要能解析就带回来，便于界面显示"证书是给谁的/什么时候到期"） */
  payload: LicensePayload | null
  /** 面向用户的一句话原因（界面直接显示） */
  message: string
}

/** 结果码 → 人话（界面直接展示；集中一份，避免各处措辞漂移） */
export const LICENSE_CODE_TEXT: Record<LicenseCode, string> = {
  ok: '授权有效',
  no_public_key: '本程序未配置许可证公钥（供应商尚未执行 tools/license-keygen.ts）',
  malformed: '证书格式不正确（复制时可能漏字或被截断，请整段粘贴）',
  bad_signature: '证书签名无效（内容被篡改，或不是本程序的供应商签发）',
  fingerprint_mismatch: '证书与本机机器码不匹配（这是发给另一台机器的证书）',
  grace_expired: '授权已过期（且已超出离线宽限期）',
  clock_rollback: '检测到系统时间被调回（授权按累计使用时间判定）—— 请把系统时间校准到正确时间后重试',
}

/** base64url 字符集（严格校验：`Buffer.from` 对非法字符是**静默忽略**的，不先卡住会放过脏输入） */
const B64U_RE = /^[A-Za-z0-9_-]+$/

/** 机器码：16 位小写 hex */
const MACHINE_CODE_RE = /^[0-9a-f]{16}$/

export function b64uEncode(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

/** 解码 base64url；非法字符/空串一律返回 `null`（**不抛异常**，调用方按 malformed 处理） */
export function b64uDecode(text: string): Buffer | null {
  if (!text || !B64U_RE.test(text)) return null
  try {
    return Buffer.from(text, 'base64url')
  } catch {
    // 理论上进不来（字符集已卡过），但 base64url 解码器未来行为不该被我们假设 ⇒ 兜底为 malformed
    return null
  }
}

/**
 * 把用户看到的机器码（`A1B2-C3D4-E5F6-7890`，允许小写/空格/少连字符）归一成 16 位小写 hex。
 * 长度不对 ⇒ 返回空串（调用方报"机器码不合法"），**不做任何猜测性修补**。
 */
export function normalizeMachineCode(raw: unknown): string {
  const hex = String(raw ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase()
  return MACHINE_CODE_RE.test(hex) ? hex : ''
}

/** 归一 hex → 显示用机器码（4 位一组、大写；用户要念给供应商听的就是这一串） */
export function formatMachineCode(hex: string): string {
  const norm = normalizeMachineCode(hex)
  if (!norm) return ''
  return (norm.match(/.{1,4}/g) ?? []).join('-').toUpperCase()
}

/** 载荷结构校验（**逐字段**卡；只判断"形状"，签名由 `verifyCertificate` 负责） */
export function isLicensePayload(value: unknown): value is LicensePayload {
  if (!value || typeof value !== 'object') return false
  const o = value as Record<string, unknown>
  return (
    o.v === LICENSE_CERT_VERSION &&
    typeof o.lic === 'string' &&
    typeof o.sub === 'string' &&
    typeof o.fp === 'string' &&
    MACHINE_CODE_RE.test(o.fp) &&
    Array.isArray(o.feat) &&
    o.feat.every((f) => typeof f === 'string') &&
    Number.isFinite(o.iat) &&
    Number.isFinite(o.exp) &&
    Number.isFinite(o.grace) &&
    // 宽限必须不早于正常到期，否则"降级运行"这段区间就没有意义（顺序反了 = 载荷被篡改或工具写错）
    (o.grace as number) >= (o.exp as number)
  )
}

/** 证书的**可读部分**：`<body>.<sig>` 拆开（不做任何校验；校验见 `verifyCertificate`） */
export function splitCertificate(cert: string): { body: string; sig: string } | null {
  // 粘贴容错：用户从微信/记事本复制常带上换行与空格 ⇒ 先剥掉所有空白再拆
  const clean = String(cert ?? '').replace(/\s+/g, '')
  const dot = clean.indexOf('.')
  if (dot <= 0 || dot >= clean.length - 1) return null
  return { body: clean.slice(0, dot), sig: clean.slice(dot + 1) }
}

/** 解析载荷（**不验签**）。只用于"证书能读出来、但还没验"的展示场景。 */
export function decodeCertificate(cert: string): LicensePayload | null {
  const parts = splitCertificate(cert)
  if (!parts) return null
  const raw = b64uDecode(parts.body)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'))
    return isLicensePayload(parsed) ? parsed : null
  } catch {
    // 载荷不是合法 JSON ⇒ 视为 malformed（调用方据此报"格式不正确"）
    return null
  }
}

/**
 * 用**私钥**签发一张证书。仅供供应商本机工具 `tools/license-issue.ts` 调用；
 * **客户端代码永远不 import 这个函数的私钥路径**（本模块只接受 pem 入参，不读文件）。
 */
export function signCertificate(payload: LicensePayload, privateKeyPem: string): string {
  const body = b64uEncode(JSON.stringify(payload))
  const sig = sign(null, Buffer.from(body, 'utf8'), privateKeyPem)
  return `${body}.${sig.toString('base64url')}`
}

/** 组装载荷并签发（把"默认值/单位换算"这类易错点收在一处，工具只传业务参数） */
export function issueCertificate(
  input: { lic: string; sub: string; fingerprint: string; features?: string[]; days?: number; nowMs?: number },
  privateKeyPem: string,
): { certificate: string; payload: LicensePayload } {
  const fp = normalizeMachineCode(input.fingerprint)
  if (!fp) throw new Error('机器码不合法：应为 16 位 hex（形如 A1B2-C3D4-E5F6-7890）')
  const days = Number.isFinite(input.days) && (input.days as number) > 0 ? Math.floor(input.days as number) : 365
  const now = Math.floor((input.nowMs ?? Date.now()) / 1000)
  const payload: LicensePayload = {
    v: LICENSE_CERT_VERSION,
    lic: input.lic,
    sub: input.sub,
    fp,
    feat: input.features && input.features.length ? [...input.features] : ['pro'],
    iat: now,
    exp: now + days * 86400,
    // 离线宽限：到期后再给 14 天（用户出差/断网时不会突然用不了，供应商也有时间催续期）
    grace: now + (days + 14) * 86400,
  }
  return { certificate: signCertificate(payload, privateKeyPem), payload }
}

/**
 * 校验证书。**这是整套授权的唯一判据**，其它地方不许再自己实现一遍。
 *
 * @param cert          用户粘贴的证书（内部已做空白剥离，粘贴带换行也认）
 * @param publicKeyPem  内嵌公钥（SPKI PEM）。**空串 = 未配置 ⇒ 直接拒绝**（fail closed）
 * @param opts.fingerprint 本机机器指纹（16 位小写 hex）
 * @param opts.nowMs    可注入的"当前时间"（单测用；默认 `Date.now()`）
 */
export function verifyCertificate(
  cert: string,
  publicKeyPem: string,
  opts: { fingerprint: string; nowMs?: number },
): LicenseCheck {
  const fail = (code: LicenseCode, payload: LicensePayload | null = null): LicenseCheck => ({
    ok: false,
    code,
    degraded: false,
    payload,
    message: LICENSE_CODE_TEXT[code],
  })

  // ① 公钥没配置就**一律拒绝**：绝不允许"没配公钥 ⇒ 谁都能用"这种静默放行
  if (!String(publicKeyPem ?? '').trim()) return fail('no_public_key')

  const parts = splitCertificate(cert)
  if (!parts) return fail('malformed')

  const payload = decodeCertificate(cert)
  if (!payload) return fail('malformed')

  const sig = b64uDecode(parts.sig)
  if (!sig) return fail('malformed', payload)

  // ② 验签（先验签再看别的：任何未经验签的字段都不可信）
  let signatureOk = false
  try {
    signatureOk = verify(null, Buffer.from(parts.body, 'utf8'), createPublicKey(publicKeyPem), sig)
  } catch {
    // 公钥本身格式坏（被改坏 / 不是 SPKI PEM）⇒ 同样按 bad_signature 拒绝，绝不放过
    signatureOk = false
  }
  if (!signatureOk) return fail('bad_signature', payload)

  // ③ 设备绑定
  const fp = normalizeMachineCode(opts.fingerprint)
  if (fp !== payload.fp) return fail('fingerprint_mismatch', payload)

  // ④ 有效期（含时钟偏差容差）
  const now = Math.floor((opts.nowMs ?? Date.now()) / 1000)
  if (now + LICENSE_CLOCK_SKEW_S < payload.iat) return fail('malformed', payload)
  if (now > payload.grace + LICENSE_CLOCK_SKEW_S) return fail('grace_expired', payload)

  return {
    ok: true,
    code: 'ok',
    // 过了 exp、但仍在宽限内 ⇒ 降级放行（界面提示"请尽快续期"）
    degraded: now > payload.exp,
    payload,
    message: LICENSE_CODE_TEXT.ok,
  }
}
