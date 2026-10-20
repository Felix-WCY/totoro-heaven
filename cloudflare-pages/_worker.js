/**
 * 授权激活服务 · Cloudflare Pages（高级模式 `_worker.js`）
 *
 * ## 为什么用 `_worker.js` 而不是 `functions/`
 * 实测：`wrangler pages deploy` 对 `functions/` 目录**没有**编译成 Worker，
 * 只当静态文件上传（`POST /activate` 返回 405，是静态层在拒）。换成高级模式后
 * Pages 会把这个文件当 Worker 跑，所有路径都进来，行为确定。
 *
 * ## 路由
 * ```
 * GET  /                 状态页
 * GET  /health           健康检查（私钥是否加载、KV 是否绑定、卡密总数）
 * POST /activate         {card, machineCode}   ← 客户端调用
 * POST /admin/cards      {count, days, sub}    ← 批量发卡（Bearer ADMIN_TOKEN）
 * GET  /admin/cards      查库存与使用明细
 * ```
 *
 * ## 需要的配置（Cloudflare 控制台）
 * | 类型 | 名字 | 内容 |
 * | --- | --- | --- |
 * | Secret | `LICENSE_PEM` | 私钥文件全文 |
 * | Secret | `ADMIN_TOKEN` | 发卡管理密钥（≥24 位随机） |
 * | KV 绑定 | `CARDS` | 卡密台账命名空间 |
 *
 * ## 证书格式（必须与客户端 certificate.ts 逐字节一致）
 * ```
 * body = base64url(JSON.stringify(payload))   // 字段顺序 v,lic,sub,fp,feat,iat,exp,grace
 * sig  = Ed25519(body 的 UTF-8 字节)           // 签 body 字符串，不是 JSON 原文
 * cert = body + '.' + base64url(sig)
 * ```
 */

const DEFAULT_DAYS = 365
/** 离线宽限：正常到期后再给 **半天**（12 小时）—— 够用户联系续期，又不让"过期"形同虚设 */
const GRACE_S = 12 * 60 * 60
const CARD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 去掉易混的 I O 0 1

// ───────────────────────── 基础工具 ─────────────────────────

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    },
  })

const b64uFromBytes = (bytes) => {
  let bin = ''
  const arr = new Uint8Array(bytes)
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const b64uFromString = (str) => b64uFromBytes(new TextEncoder().encode(str))

/** PEM → PKCS8 DER（Workers 只能导入 DER） */
function pemToDer(pem) {
  const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const bin = atob(b64)
  const der = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i)
  return der
}

/** isolate 内缓存签名密钥，省掉每次 importKey */
let cachedKey = null
async function signingKey(env) {
  if (cachedKey) return cachedKey
  const pem = env.LICENSE_PEM
  if (!pem || !String(pem).includes('BEGIN PRIVATE KEY')) return null
  cachedKey = await crypto.subtle.importKey('pkcs8', pemToDer(pem), { name: 'Ed25519' }, false, ['sign'])
  return cachedKey
}

function genCard() {
  let s = ''
  for (let i = 0; i < 8; i++) s += CARD_ALPHABET[Math.floor(Math.random() * CARD_ALPHABET.length)]
  return `TH-${s.slice(0, 4)}-${s.slice(4, 8)}`
}

function normalizeCard(raw) {
  const clean = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!/^TH[A-Z0-9]{8}$/.test(clean)) return ''
  return `TH-${clean.slice(2, 6)}-${clean.slice(6, 10)}`
}

function normalizeMachineCode(raw) {
  const hex = String(raw ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase()
  return /^[0-9a-f]{16}$/.test(hex) ? hex : ''
}

function genLicId() {
  const pick = () => CARD_ALPHABET[Math.floor(Math.random() * CARD_ALPHABET.length)]
  return `TH-${pick()}${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}${pick()}`
}

/** 恒定时间比较（防时序侧信道猜管理密钥） */
function tokenOk(given, want) {
  if (!want) return false
  const a = String(given || '').replace(/^Bearer\s+/i, '').trim()
  if (a.length !== want.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ want.charCodeAt(i)
  return diff === 0
}

// ───────────────────────── 签发证书 ─────────────────────────

async function issueCertificate(env, cardMeta, fp) {
  const key = await signingKey(env)
  if (!key) throw new Error('服务端未配置私钥 LICENSE_PEM')

  const now = Math.floor(Date.now() / 1000)
  const days = Number.isFinite(cardMeta.days) && cardMeta.days > 0 ? Math.floor(cardMeta.days) : DEFAULT_DAYS
  // ⚠️ 字段顺序必须与客户端一致（v, lic, sub, fp, feat, iat, exp, grace）
  const payload = {
    v: 1,
    lic: genLicId(),
    sub: cardMeta.sub || '用户',
    fp,
    feat: ['pro'],
    iat: now,
    exp: now + days * 86400,
    grace: now + days * 86400 + GRACE_S,
  }
  const body = b64uFromString(JSON.stringify(payload))
  const sig = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(body))
  return { certificate: `${body}.${b64uFromBytes(sig)}`, payload }
}

// ───────────────────────── 主逻辑 ─────────────────────────

// ───────────────────────── 撞库防护（限流）─────────────────────────
/**
 * `/activate` 是唯一能探测「某张卡密是否存在」的入口，必须限频。
 *
 * 额度设计（卡密空间 32^8 ≈ 1.1 万亿，正常买家一次就对）：
 *   · 每 IP 每 60 秒最多 **20 次** `/activate` —— 挡住原始洪泛
 *   · 每 IP 每 10 分钟最多 **6 次失败** —— 挡住稳定爆破
 *
 * **刻意不占 KV 写入额度**：KV 免费档只有 1000 写/天。若用 KV 记失败次数，
 * 攻击者一天就能把写配额打光 ⇒ 正常买家全部激活失败。所以计数走 **Cache API**
 * （每数据中心的边缘缓存，不计入 KV 额度）。Cache API 异常时降级到进程内 Map
 * （只在本 isolate 有效，跨机房不准，但能挡住单点爆破）。
 */
const memCounters = new Map()

/**
 * **全站熔断**（用户要求「不能没有上限」）。
 *
 * 单 IP 限流挡不住"换一大把代理 IP"的撞库。这里再加一层**全局**上限：
 * 任一数据中心一小时内累计失败 ≥ `GLOBAL_FAIL_LIMIT` ⇒ 往 KV 写一个熔断标记，
 * 之后**所有** `/activate`（不分 IP、不分机房）统一返回 503，持续 `GLOBAL_BLOCK_TTL` 秒。
 *
 * ## 为什么标记才写 KV
 * KV 免费档只有 1000 写/天。若每次失败都写 KV 计数，攻击者几千次就把配额打光，
 * 正常买家反而全部激活失败。所以：**失败计数走 Cache API（不占配额）**，
 * 只有"触发熔断"这一刻才写 KV —— 最多 1 次/小时。
 */
const GLOBAL_FAIL_LIMIT = 100
const GLOBAL_BLOCK_TTL = 3600

/**
 * **单 IP 封禁**（用户要求「单个反复错直接封了」）。
 *
 * 上面前两档（每分钟 20 次 / 每 10 分钟 6 次失败）只是"减速"，冷却期一过还能再来。
 * 这一档是**真封**：24 小时内累计失败 ≥ `IP_BAN_THRESHOLD` 次 ⇒ 该 IP 的 `/activate`
 * 直接 403，持续 `IP_BAN_WINDOW`（24 小时），到期自动解除。
 *
 * 阈值取 15：正常买家手滑 3~4 次碰不到；稳定爆破的 IP 几分钟就超。
 * 计数与封禁标记都在 Cache API（不占 KV 写配额），按数据中心生效。
 */
const IP_BAN_WINDOW = 24 * 60 * 60
const IP_BAN_THRESHOLD = 15

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown'
}

async function counterGet(key) {
  try {
    const hit = await caches.default.match(`https://rl.totoro.invalid/${key}`)
    return hit ? Number(await hit.text()) || 0 : 0
  } catch {
    const cur = memCounters.get(key)
    return cur && Date.now() <= cur.resetAt ? cur.n : 0
  }
}

async function counterInc(key, windowSec) {
  try {
    const url = `https://rl.totoro.invalid/${key}`
    const hit = await caches.default.match(url)
    const n = (hit ? Number(await hit.text()) || 0 : 0) + 1
    await caches.default.put(
      url,
      new Response(String(n), { headers: { 'Cache-Control': `max-age=${windowSec}` } }),
    )
    return n
  } catch {
    const now = Date.now()
    const cur = memCounters.get(key)
    if (!cur || now > cur.resetAt) {
      memCounters.set(key, { n: 1, resetAt: now + windowSec * 1000 })
      return 1
    }
    cur.n += 1
    return cur.n
  }
}

/** 全站是否处于熔断状态（只读 KV 一个 key，不产生写入） */
async function globallyBlocked(env) {
  try {
    return Boolean(await env.CARDS.get('guard:blocked'))
  } catch {
    return false
  }
}

/**
 * 记一次失败：本机房计数 +1；跨过阈值就写熔断标记（全站生效，最多 1 次写入/小时）。
 * 调用方**不要**在热路径上重复调用 —— 每次失败一次即可。
 */
async function noteFailure(env, ip) {
  // a) 全站熔断计数（跨机房用 KV 标记，见 GLOBAL_FAIL_LIMIT）
  const n = await counterInc('gfails', GLOBAL_BLOCK_TTL)
  if (n >= GLOBAL_FAIL_LIMIT) {
    try {
      await env.CARDS.put('guard:blocked', new Date().toISOString(), { expirationTtl: GLOBAL_BLOCK_TTL })
    } catch {
      // 写不进去就只在本机房限流，不影响正常激活
    }
  }
  // b) 单 IP 24 小时失败累计 ⇒ 超阈值直接封禁（到期自动解除）
  if (ip) {
    const daily = await counterInc(`h24:${ip}`, IP_BAN_WINDOW)
    if (daily >= IP_BAN_THRESHOLD) await counterInc(`ban:${ip}`, IP_BAN_WINDOW)
  }
}

async function handle(request, env) {
  const url = new URL(request.url)
  const path = url.pathname

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      },
    })
  }

  // ── 首页：状态页
  if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
    const keyOk = Boolean(await signingKey(env))
    const kvOk = Boolean(env.CARDS)
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>授权激活服务</title>
<style>body{font:15px/1.75 system-ui,"Microsoft YaHei",sans-serif;background:#0f1115;color:#d7dbe0;
padding:40px;max-width:640px;margin:0 auto}h1{font-size:19px}code{background:#1c2027;padding:2px 6px;border-radius:4px}
.ok{color:#4ade80}.bad{color:#f87171}a{color:#6ea8fe}</style></head><body>
<h1>🔑 授权激活服务</h1>
<p>私钥：<b class="${keyOk ? 'ok' : 'bad'}">${keyOk ? '已加载 ✅' : '未配置 ❌'}</b></p>
<p>卡密库（KV）：<b class="${kvOk ? 'ok' : 'bad'}">${kvOk ? '已绑定 ✅' : '未绑定 ❌'}</b></p>
<p>接口：<code>GET /health</code> · <code>POST /activate</code> ·
<code>POST /admin/cards</code> · <code>GET /admin/cards</code></p>
<p>把这个地址填进程序的激活服务配置即可。</p>
</body></html>`
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
  }

  // ── 健康检查
  if (request.method === 'GET' && path === '/health') {
    const keyOk = Boolean(await signingKey(env))
    let cardsTotal = 0
    try {
      const list = await env.CARDS.list({ limit: 1000 })
      cardsTotal = list.keys.length
    } catch {
      // KV 没绑或读失败：不影响健康检查本身
    }
    return json({ ok: true, keyLoaded: keyOk, kvBound: Boolean(env.CARDS), cardsTotal, time: new Date().toISOString() })
  }

  // ── 解除单个 IP 的封禁（卖家人工放行；封禁 24 小时后也会自动过期）
  if (request.method === 'POST' && path === '/admin/unban') {
    if (!tokenOk(request.headers.get('Authorization'), env.ADMIN_TOKEN)) {
      return json({ ok: false, error: '未授权' }, 401)
    }
    let b = {}
    try { b = await request.json() } catch { /* 忽略 */ }
    const target = String(b.ip || '').trim()
    if (!target) return json({ ok: false, error: '请在请求体里给出 ip' }, 400)
    for (const k of [`ban:${target}`, `bad:${target}`, `h24:${target}`, `act:${target}`]) {
      try { await caches.default.delete(`https://rl.totoro.invalid/${k}`) } catch { /* 忽略 */ }
    }
    return json({ ok: true, message: `已解除 ${target} 的封禁（本机房）` })
  }

  // ── 解除全站熔断（卖家人工放行；熔断也会在 1 小时后自动过期）
  if (request.method === 'POST' && path === '/admin/unblock') {
    if (!tokenOk(request.headers.get('Authorization'), env.ADMIN_TOKEN)) {
      return json({ ok: false, error: '未授权' }, 401)
    }
    await env.CARDS.delete('guard:blocked')
    await env.CARDS.delete('guard:fails')
    return json({ ok: true, message: '已解除熔断，激活恢复' })
  }

  // ── 激活
  if (request.method === 'POST' && path === '/activate') {
    let body
    try {
      body = await request.json()
    } catch {
      return json({ ok: false, error: '请求体不是合法 JSON' }, 400)
    }
    const card = normalizeCard(body.card)
    const fp = normalizeMachineCode(body.machineCode)
    if (!card) return json({ ok: false, error: '卡密格式不正确（应为 TH-XXXX-XXXX）' }, 400)
    if (!fp) return json({ ok: false, error: '机器码格式不正确（应为 16 位十六进制）' }, 400)
    if (!env.CARDS) return json({ ok: false, error: '服务端未绑定 KV（CARDS），无法记录卡密状态' }, 500)

    // ── 撞库防护：在真正查 KV 之前拦下来（避免被刷光读写额度）
    const ip = clientIp(request)
    // ① 全站熔断闸：一旦触发，**所有 IP** 都停（防"换一大批代理 IP"绕过单 IP 限流）
    if (await globallyBlocked(env)) {
      return json({ ok: false, error: '激活服务暂时繁忙，请 1 小时后再试（异常流量防护已触发）' }, 503)
    }
    // ①' 封禁闸：该 IP 24 小时内失败超阈值 ⇒ 直接拒（冷却到期前不再放行）
    if ((await counterGet(`ban:${ip}`)) > 0) {
      return json({ ok: false, error: '该网络已被临时封禁（24 小时），请更换网络或联系店铺客服' }, 403)
    }
    // ② 原始洪泛闸：每分钟最多 20 次
    if ((await counterInc(`act:${ip}`, 60)) > 20) {
      return json({ ok: false, error: '请求过于频繁，请稍后再试（每分钟最多 20 次）' }, 429)
    }
    // ② 失败闸：10 分钟内错 6 次就先锁住（正常买家不会连错 6 次）
    if ((await counterGet(`bad:${ip}`)) >= 6) {
      return json({ ok: false, error: '尝试失败次数过多，请 10 分钟后再试；卡密可向店铺客服核对' }, 429)
    }

    const raw = await env.CARDS.get(`card:${card}`)
    if (!raw) {
      await counterInc(`bad:${ip}`, 600)
      await noteFailure(env, ip)
      return json({ ok: false, error: '卡密不存在，请核对是否输入有误' }, 404)
    }

    let meta
    try {
      meta = JSON.parse(raw)
    } catch {
      return json({ ok: false, error: '卡密记录损坏，请联系发布者' }, 500)
    }
    if (meta.usedAt) {
      await counterInc(`bad:${ip}`, 600)
      await noteFailure(env, ip)
      return json({ ok: false, error: '这张卡密已被使用过了' }, 409)
    }

    let issued
    try {
      issued = await issueCertificate(env, meta, fp)
    } catch (err) {
      return json({ ok: false, error: '签发失败：' + (err instanceof Error ? err.message : String(err)) }, 500)
    }

    // ⚠️ 先写"已使用"再返回：写失败则拒绝本次激活，否则同卡可无限用
    meta.usedAt = new Date().toISOString()
    meta.usedBy = fp
    meta.licId = issued.payload.lic
    try {
      await env.CARDS.put(`card:${card}`, JSON.stringify(meta))
    } catch (err) {
      return json({ ok: false, error: '服务端台账写入失败，请稍后重试：' + (err instanceof Error ? err.message : String(err)) }, 500)
    }

    return json({
      ok: true,
      certificate: issued.certificate,
      lic: issued.payload.lic,
      sub: issued.payload.sub,
      exp: issued.payload.exp,
      grace: issued.payload.grace,
    })
  }

  // ── 管理：发卡
  if (request.method === 'POST' && path === '/admin/cards') {
    if (!tokenOk(request.headers.get('Authorization'), env.ADMIN_TOKEN)) return json({ ok: false, error: '未授权' }, 401)
    if (!env.CARDS) return json({ ok: false, error: '服务端未绑定 KV（CARDS）' }, 500)

    let body = {}
    try {
      body = await request.json()
    } catch {
      // 允许空请求体，走默认值
    }
    const count = Math.min(Math.max(Math.floor(Number(body.count) || 1), 1), 200)
    const days = Math.floor(Number(body.days) || DEFAULT_DAYS)
    const sub = String(body.sub || '').trim() || '用户'

    const made = []
    for (let i = 0; i < count; i++) {
      let card = genCard()
      while (await env.CARDS.get(`card:${card}`)) card = genCard()
      await env.CARDS.put(
        `card:${card}`,
        JSON.stringify({ card, days, sub, createdAt: new Date().toISOString(), usedAt: null, usedBy: null, licId: null }),
      )
      made.push(card)
    }
    return json({ ok: true, count: made.length, days, sub, cards: made })
  }

  // ── 管理：查卡
  if (request.method === 'GET' && path === '/admin/cards') {
    if (!tokenOk(request.headers.get('Authorization'), env.ADMIN_TOKEN)) return json({ ok: false, error: '未授权' }, 401)
    if (!env.CARDS) return json({ ok: false, error: '服务端未绑定 KV（CARDS）' }, 500)

    const limit = Math.min(Math.max(Math.floor(Number(url.searchParams.get('limit')) || 100), 1), 1000)
    const list = await env.CARDS.list({ limit: 1000 })
    const unused = []
    const used = []
    for (const k of list.keys) {
      const raw = await env.CARDS.get(k.name)
      if (!raw) continue
      let m
      try {
        m = JSON.parse(raw)
      } catch {
        continue
      }
      const item = { card: m.card, days: m.days, createdAt: m.createdAt, usedAt: m.usedAt, usedBy: m.usedBy, licId: m.licId }
      if (m.usedAt) used.push(item)
      else unused.push(item)
    }
    return json({
      ok: true,
      total: list.keys.length,
      unusedCount: unused.length,
      usedCount: used.length,
      unused: unused.slice(-limit),
      used: used.slice(-limit),
    })
  }

  return json({ ok: false, error: 'Not Found' }, 404)
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env)
    } catch (err) {
      return json({ ok: false, error: '服务内部错误：' + (err instanceof Error ? err.message : String(err)) }, 500)
    }
  },
}
