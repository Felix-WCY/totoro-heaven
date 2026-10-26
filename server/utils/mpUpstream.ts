/**
 * 上游基址校验（服务端共用）
 *
 * ## 为什么需要独立一个模块
 * 多租户后，"该校 API 基址"可能是共享域（`wxxcx.xtotoro.com`）也可能是各校**独立租户域**
 * （如辽宁科技大学 `yanggpa.ustl.edu.cn`）。凡是**服务端直接发上游请求**的地方都必须：
 *   ① 接受调用方传入的基址（不能写死共享域，否则租户学校必然失败）；
 *   ② 按白名单校验（否则就是 SSRF：任何能访问本机服务的东西都能借它打任意主机）。
 *
 * 已有两个调用方：
 *   - `server/api/mp/[...slug].ts`（代理，自己带一份等价逻辑）
 *   - `server/api/local/mornsign-submit.post.ts`（早操签到提交，原实现写死了共享域）
 */
import { KNOWN_SCHOOL_DOMAINS } from '../../utils/mp/schoolGate'

/** 允许的主机后缀（供应商自有域） */
const ALLOWED_SUFFIXES = ['xtotoro.com']

/**
 * 校验并归一化上游基址。
 * @param raw 调用方传入的基址（可能是 `https://host/`、`https://host`，也可能是空）
 * @param fallback 不合法/未传时返回的兜底值（通常是共享域）
 * @returns 合法则返回 `https://host`（去掉路径与末尾斜杠）；否则返回 `fallback`
 */
export function normalizeAllowedBase(raw: unknown, fallback: string): string {
  const text = String(raw ?? '').trim()
  if (!text) return fallback
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return fallback
  }
  // 必须 HTTPS（绝不把 token 以明文 HTTP 发出去）+ 不允许带凭据
  if (url.protocol !== 'https:') return fallback
  if (url.username || url.password) return fallback

  const host = url.host.toLowerCase()
  const exact = KNOWN_SCHOOL_DOMAINS.includes(host)
  const suffixOk = ALLOWED_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))
  return exact || suffixOk ? `${url.protocol}//${url.host}` : fallback
}
