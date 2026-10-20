/**
 * 授权激活服务 · Cloudflare Pages Functions 版
 *
 * ## 为什么是"Functions"
 * `*.pages.dev` 本身只能放静态文件，**签不了证书**。Pages Functions 让它能跑代码，
 * 且同样免费（10 万请求/天）。Ed25519 由 Workers 的 WebCrypto 原生支持
 * （见 https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ 的算法表），
 * 所以客户端一行都不用改。
 *
 * ## 路由（这个文件挂在 `functions/[[path]].js`，接管所有路径）
 * ```
 * GET  /                 简单的状态页（确认部署成功）
 * GET  /health           健康检查：私钥是否加载、卡密总数
 * POST /activate         {card, machineCode}  ← 客户端调用
 * POST /admin/cards      {count, days, sub}   ← 批量发卡（需 Bearer ADMIN_TOKEN）
 * GET  /admin/cards      查库存与使用明细
 * ```
 *
 * ## 需要配的三个东西（Cloudflare 控制台里设）
 * | 类型 | 名字 | 内容 |
 * | --- | --- | --- |
 * | Secret | `LICENSE_PEM` | 私钥文件 `license-private.pem` 的完整内容 |
 * | Secret | `ADMIN_TOKEN` | 发卡管理密钥（自己定，≥24 位随机） |
 * | KV 绑定 | `CARDS` | 卡密台账用的 KV 命名空间 |
 *
 * ## 证书格式（必须与客户端逐字节一致）
 * ```
 * body = base64url(JSON.stringify(payload))   // 字段顺序 v,lic,sub,fp,feat,iat,exp,grace
 * sig  = Ed25519_sign(body 的 UTF-8 字节)      // 签的是 body 字符串，不是 JSON 原文
 * cert = body + '.' + base64url(sig)
 * ```
 */

const DEFAULT_DAYS = 365
const GRACE_DAYS = 14
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

/** 进程内缓存签名密钥（同一个 isolate 复用，省掉每次 importKey） */
let cachedKey = null
async function signingKey(env) {
  if (cachedKey) return cachedKey
  const pem = env.LICENSE_PEM
  if (!pem || !String(pem).includes('BEGIN PRIVATE KEY')) return null
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(pem), { name: 'Ed25519' }, false, ['sign'])
  cachedKey = key
  return key
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

/**
 * 与客户端 `certificate.ts` 的 signCertificate 逐字节一致。
 * @param {{days:number, sub:string}} cardMeta
 * @param {string} fp 16 位小写 hex
 */
async function issueCertificate(env, cardMeta, fp) {
  const key = await signingKey(env)
  if (!key) throw new Error('服务端未配置私钥 LICENSE_PEM')

  const now = Math.floor(Date.now() / 1000)
  const days = Number.isFinite(cardMeta.days) && cardMeta.days > 0 ? Math.floor(cardMeta.days) : DEFAULT_DAYS
  // ⚠️ 字段顺序必须与客户端一致
  const payload = {
    v: 1,
    lic: genLicId(),
    sub: cardMeta.sub || '用户',
    fp,
    feat: ['pro'],
    iat: now,
    exp: now + days * 86400,
    grace: now + (days + GRACE_DAYS) * 86400,
  }
  const body = b64uFromString(JSON.stringify(payload))
  const sig = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(body))
  return { certificate: `${body}.${b64uFromBytes(sig)}`, payload }
}

// ───────────────────────── 入口 ─────────────────────────

export async function onRequest(context) {
  const { request, env } = context
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

  // ── 根路径：状态页（用于确认部署成功）
  if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
    const keyOk = Boolean(await signingKey(env))
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>授权激活服务</title>
<style>body{font:15px/1.7 system-ui,"Microsoft YaHei",sans-serif;background:#0f1115;color:#d7dbe0;
padding:40px;max-width:640px;margin:0 auto}h1{font-size:19px}code{background:#1c2027;padding:2px 6px;border-radius:4px}
.ok{color:#4ade80}.bad{color:#f87171}</style></head><body>
<h1>🔑 授权激活服务</h1>
<p>私钥：<b class="${keyOk ? 'ok' : 'bad'}">${keyOk ? '已加载 ✅' : '未配置 ❌'}</b></p>
<p>可用接口：</p>
<ul><li><code>GET /health</code></li><li><code>POST /activate</code></li>
<li><code>POST /admin/cards</code>（需管理密钥）</li><li><code>GET /admin/cards</code>（需管理密钥）</li></ul>
<p>这个地址填进程序的激活服务配置即可。</p>
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
      // KV 没绑或读失败：不影响健康检查，只在卡数上显示 0
    }
    return json({ ok: true, keyLoaded: keyOk, cardsTotal, kvBound: Boolean(env.CARDS), time: new Date().toISOString() })
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

    const raw = await env.CARDS.get(`card:${card}`)
    if (!raw) return json({ ok: false, error: '卡密不存在，请核对是否输入有误' }, 404)

    let meta
    try {
      meta = JSON.parse(raw)
    } catch {
      return json({ ok: false, error: '卡密记录损坏，请联系发布者' }, 500)
    }
    if (meta.usedAt) return json({ ok: false, error: '这张卡密已被使用过了' }, 409)

    let issued
    try {
      issued = await issueCertificate(env, meta, fp)
    } catch (err) {
      return json({ ok: false, error: '签发失败：' + (err instanceof Error ? err.message : String(err)) }, 500)
    }

    // ⚠️ 先写"已使用"再返回：写失败就**拒绝本次激活**，否则同一张卡可无限用
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
      // 极小概率撞号：存在就重新生成
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
