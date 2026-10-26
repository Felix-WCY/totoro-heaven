/**
 * `POST /api/local/token-import` —— 扫描器回传候选 token（仅本机 + 一次性 nonce）
 *
 * 关键设计：**扫描器只回传候选，验活由服务端做** ——
 * 内存里可能残留旧 token（用户 2026-09-15 实测就撞到过），只取第一个会拿到失效的。
 * 这里逐个调 `GetStudentInfoByToken`，取第一个真正有效的。
 *
 * 🔒 token 不打印、不落盘；对外只返回"验活了几条"，token 本体由前端通过 status 端点取走。
 */
import { MP_ENDPOINTS, MP_HOST } from '../../../src/mp/types'
import { judgeMpResponse, unwrapMpResponse } from '../../../src/mp/envelope'
import { isTokenShape, maskToken, sanitizeCandidates } from '../../../utils/mp/tokenScan'
import type { TokenScanProfile } from '../../utils/tokenScanState'
import { assertLocalRequest, fingerprintOf, getScan, nonceMatches, patchScan } from '../../utils/tokenScanState'
import { logInfo, logWarn } from '../../utils/logger'

/**
 * 用候选 token 调 `GetStudentInfoByToken` 验活。
 *
 * ⚠️ `base` 必须是**该校自己的域名**：租户学生（如辽宁科技大学 `yanggpa.ustl.edu.cn`）
 * 的 token 在共享域上会被判「token失效，注册失败」。
 *
 * 🔴 **验活会消耗旧 token**（2026-10-26 诊断包实测）：
 *    同一 token 在 `yanggpa` 验活成功后 **~1 秒**，用它再调同一个端点就变成
 *    「token失效，注册失败」，之后 7 个域名全部失败。
 *    该接口的响应是**带顶层 `token` 字段的**（学校列表接口同样有），
 *    说明服务端在认证成功时**下发新 token、旧 token 立即作废**。
 *    ⇒ 必须把响应里的新 token 一路传下去，否则后续请求必然全灭。
 *
 * @returns 命中时返回档案摘要 + 实际基址 + **可用的 token**（可能是服务端新发的）
 */
async function validateToken(
  token: string,
  base: string,
): Promise<{ profile: TokenScanProfile; base: string; token: string } | null> {
  try {
    const res = await fetch(`${base}${MP_ENDPOINTS.studentInfoByToken.path}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json;charset=UTF-8', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    })
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!json) return null
    const verdict = judgeMpResponse(json, MP_ENDPOINTS.studentInfoByToken.payload)
    if (!verdict.ok) return null
    const obj = unwrapMpResponse<Record<string, unknown>>(json, MP_ENDPOINTS.studentInfoByToken.payload)
    if (!obj?.snCode) return null

    /** 服务端可能下发新 token（形如 `WXXCX…`）；`null`/空/`"null"` 都视为没有 */
    const pickToken = (...cands: unknown[]): string => {
      for (const c of cands) {
        const s = typeof c === 'string' ? c.trim() : ''
        if (s && s !== 'null' && isTokenShape(s)) return s
      }
      return token
    }
    const fresh = pickToken(json.token, obj.token)

    return {
      profile: {
        snCode: String(obj.snCode),
        schoolName: obj.schoolName ? String(obj.schoolName) : '',
        campus: obj.schoolCampusName ? String(obj.schoolCampusName) : '',
      },
      base,
      token: fresh,
    }
  } catch {
    return null
  }
}

/**
 * 验活要试哪些基址：**共享域优先，再逐个租户域**。
 *
 * 学校列表（免鉴权）一次就能拿到全部域名，实测 13 所学校分布在 6 个域名上。
 * 拿不到列表时退回只用共享域（老行为，不影响共享域学校）。
 */
async function candidateBases(): Promise<string[]> {
  const bases = [MP_HOST.replace(/\/+$/, '')]
  try {
    const res = await fetch(`${MP_HOST}/wxapi/platform/active/getSunRunSchoolList`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(8000),
    })
    const json = (await res.json()) as { body?: Array<{ domainUrl?: string }> }
    for (const s of json.body ?? []) {
      const raw = String(s.domainUrl ?? '').trim()
      if (!raw) continue
      let normalized = raw
      try {
        const u = new URL(raw)
        if (u.protocol !== 'https:') continue
        normalized = `${u.protocol}//${u.host}`
      } catch {
        continue
      }
      if (!bases.includes(normalized)) bases.push(normalized)
    }
  } catch {
    // 拿不到列表就用共享域，不阻断
  }
  return bases
}

export default defineEventHandler(async (event) => {
  assertLocalRequest(event)

  const body = (await readBody(event).catch(() => ({}))) as {
    nonce?: string
    tokens?: unknown
    error?: string
    processes?: number
    /** 🆕 2026-10-14（E80）：脚本 `trap` 自报的"死在哪一步 / 原话 / PS 版本"，让失败不再是光秃秃一个退出码 */
    phase?: string
    detail?: string
    psVersion?: string
  }

  const st = getScan()
  if (!st) throw createError({ statusCode: 409, statusMessage: '没有进行中的扫描（请重新点「获取 token」）' })
  if (!nonceMatches(st.nonce, body?.nonce)) throw createError({ statusCode: 403, statusMessage: 'nonce 不匹配' })
  if (st.used) throw createError({ statusCode: 409, statusMessage: '该 nonce 已使用过' })

  patchScan({ used: true, phase: 'validating', message: '正在逐个验活候选 token…' })

  const candidates = sanitizeCandidates(body.tokens)
  patchScan({ candidates: candidates.length })

  if (!candidates.length) {
    /**
     * 🆕 2026-10-14（E80）：脚本 `trap` 自报的失败原话 —— **比任何猜测都值钱**，直接摆给用户。
     * 老实现只给一句"可能被杀软拦截"（无依据）；而某个补丁版又反过来断言"是 `-Endpoint` 的锅"
     * （同样无依据，本机实测也否掉了）。现在改成：**脚本自己说什么就转什么**。
     */
    const detail = typeof body?.detail === 'string' ? body.detail.trim().slice(0, 400) : ''
    const hint =
      body?.error === 'SCRIPT_FAILED'
        ? `扫描脚本自己报错了（死在「${body?.phase || '未知'}」这一步）：${detail || '（脚本没给出细节）'}`
        : body?.error === 'NO_PROCESS'
        ? '未找到微信小程序进程：请先用「电脑版微信」打开并登录「龙猫体育锻炼」，保持小程序窗口开着，再点一次「一键获取 token」'
        : body?.error === 'NO_TOKEN'
          ? '进程里没找到 token：请在小程序里点开任意页面（触发一次请求）后重试；「务必保持小程序窗口开着」（关掉后内存里就没有新 token 了）'
          : '扫描器没有回传可用候选（可能被杀软拦截或微信版本不兼容）——可改用 Fiddler 抓包粘贴 token'
    patchScan({ phase: 'error', message: hint })
    logWarn('token', '扫描未拿到候选', {
      scannerError: body?.error ?? '(无)',
      phase: body?.phase ?? '',
      detail: detail.slice(0, 200), // 值级脱敏由 logFormat 负责（形似 token 的片段会被掩掉）
      psVersion: body?.psVersion ?? '',
      processes: body?.processes,
    })
    return { ok: true, validated: 0 }
  }

  logInfo('token', `扫描到 ${candidates.length} 个候选，开始逐个验活`, { candidates: candidates.length })
  /**
   * 多域名验活（2026-10-26）：**按 token 为主序**，每个 token 依次试共享域 → 各租户域。
   * 这样最常见的情况（共享域学生、有效 token 排在前面）只需 1 次请求就能命中。
   * 总预算 20 秒，超时就停（避免界面一直转圈）。
   */
  const bases = await candidateBases()
  const deadline = Date.now() + 20_000
  for (const token of candidates) {
    for (const base of bases) {
      if (Date.now() > deadline) break
      const hit = await validateToken(token, base)
      if (hit) {
        /**
         * 🔴 用**服务端下发的 token**（`hit.token`），不是候选里的那个。
         * 该端点认证成功时会换发新 token、把旧的立即作废；继续用旧的 ⇒ 后续请求全灭
         * （2026-10-26 诊断包：验活成功后 ~1 秒，同一域名再查就「token失效」）。
         */
        const sessionToken = hit.token
        const rotated = sessionToken !== token
        patchScan({
          phase: 'ready',
          message: 'token 已就绪',
          token: sessionToken,
          fingerprint: fingerprintOf(sessionToken),
          masked: maskToken(sessionToken),
          profile: hit.profile,
          // 记住是哪个域名验活成功的 —— 后续读取必须先用它，否则租户学生的 token 会被判失效
          baseUrl: hit.base,
        })
        logInfo('token', 'token 验活成功', {
          candidates: candidates.length,
          fingerprint: fingerprintOf(sessionToken),
          campus: hit.profile.campus,
          school: hit.profile.schoolName,
          // 服务端是否换发了新 token（只记布尔，不记值）
          rotated,
          viaHost: (() => {
            try {
              return new URL(hit.base).host
            } catch {
              return ''
            }
          })(),
        })
        return { ok: true, validated: 1, candidates: candidates.length }
      }
    }
    if (Date.now() > deadline) break
  }

  patchScan({
    phase: 'error',
    message:
      `扫到 ${candidates.length} 个候选，但都没通过验活（已尝试 ${bases.length} 个学校域名）。` +
      '请在「龙猫校园（龙猫体育锻炼）」小程序里【退出登录】→ 用「学号 + 姓名」重新登录 → ' +
      '「保持小程序窗口开着」→ 回到本页再点一次「一键获取 token」。' +
      '（等价且更稳：在微信里删除该小程序→重新打开→登录；两者都会解除微信绑定，请确认记得学号）',
  })
  logWarn('token', '候选都没通过验活', { candidates: candidates.length, bases: bases.length })
  return { ok: true, validated: 0, candidates: candidates.length }
})
