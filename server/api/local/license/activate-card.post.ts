/**
 * `POST /api/local/license/activate-card` —— 用**卡密**在线激活本机（仅本机）
 *
 * 请求体：`{ card: string }`
 * 返回：`{ ok, error, status }`（与手动激活接口同构，前端处理方式一致）
 *
 * ## 流程
 * ```
 * 本机 → 激活服务： POST /activate { card, machineCode }
 * 激活服务 → 本机： { ok, certificate, ... }   ← 服务器用私钥现签一张绑定本机的证书
 * 本机 → 本地验签： 走 activateLicense()      ← ⚠️ 绝不直接信任服务器返回值
 * ```
 *
 * ## 两个关键设计
 * 1. **服务端返回值不直接落盘**：必须先过本地验签（`activateLicense`）。
 *    这样即使激活服务被冒充/改地址，也签不出能通过校验的证书（对方没有私钥）。
 * 2. **失败一律 200 + ok:false**：和 `activate.post.ts` 保持一致 ——
 *    "卡密不对/已被用"是**业务结果**，要连同 status 一起给前端渲染，而不是抛 4xx。
 */
import { defineEventHandler, readBody } from 'h3'
import { activationUrl } from '../../../utils/license/activation'
import { machineFingerprint } from '../../../utils/license/instance'
import { activateLicense, getLicenseStatus } from '../../../utils/license/state'
import { assertLocalRequest } from '../../../utils/tokenScanState'
import { logInfo, logWarn } from '../../../utils/logger'

/** 请求超时：网络差时别让用户干等到怀疑人生 */
const REQUEST_TIMEOUT_MS = 20000

export default defineEventHandler(async (event) => {
  assertLocalRequest(event)
  const body = await readBody<{ card?: unknown }>(event).catch(() => null)
  const card = String(body?.card ?? '').trim()

  if (!card) {
    return { ok: false, error: '请先填写卡密', status: getLicenseStatus() }
  }

  const baseUrl = activationUrl()
  if (!baseUrl) {
    logWarn('license', '卡密激活被拒：未配置激活服务地址')
    return {
      ok: false,
      error: '本程序未启用在线激活（未配置激活服务器地址）。请联系发布者直接索要授权证书。',
      status: getLicenseStatus(),
    }
  }

  const endpoint = `${baseUrl.replace(/\/+$/, '')}/activate`
  const fingerprint = machineFingerprint()

  let payload: { ok?: boolean; certificate?: string; error?: string } | null = null
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ card, machineCode: fingerprint }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    payload = (await res.json()) as { ok?: boolean; certificate?: string; error?: string }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logWarn('license', '卡密激活请求失败', { error: msg })
    // 把"为什么连不上"说清楚：用户能据此判断是没网、还是服务器挂了
    const hint = /timeout|abort/i.test(msg) ? '服务器没有响应（超时）' : '无法连接到激活服务器'
    return { ok: false, error: `${hint}：请检查网络后重试。如果一直不行，请联系发布者手动发证书。`, status: getLicenseStatus() }
  }

  if (!payload || payload.ok !== true || !payload.certificate) {
    const reason = String(payload?.error ?? '').trim() || '激活失败，请稍后重试'
    logWarn('license', '卡密激活被服务端拒绝', { reason })
    return { ok: false, error: reason, status: getLicenseStatus() }
  }

  // 服务器给了证书 —— 但仍然**本地验签**，不信任远端（见文件头第 1 点）
  const result = activateLicense(String(payload.certificate))
  if (result.ok) {
    logInfo('license', '卡密激活成功', { subject: result.status.subject, expiresAt: result.status.expiresAt })
  } else {
    logWarn('license', '卡密激活：服务端证书本地验签失败', { error: result.error })
  }
  return { ok: result.ok, error: result.error, status: result.status }
})
