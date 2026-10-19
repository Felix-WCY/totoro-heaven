/**
 * **在线激活服务**（零依赖，一个文件，任意 Node 环境可跑）
 *
 * ## 它解决什么问题
 * 原本证书**绑机器码**，而机器码要等买家运行程序才知道 ⇒ 没法"付款即自动发货"。
 * 现在改成：付款后自动发一张**卡密**（短随机串），买家在程序里输入卡密，
 * 程序带着自己的机器码来找本服务，本服务验卡密 → 现签一张绑定该机器的证书 → 返回。
 * ⇒ **自动发货**（卡密可预生成、平台立刻发）+ **自动激活**（买家只输一次卡密）。
 *
 * ## 接口
 * ```
 * GET  /health                          健康检查
 * POST /activate        {card, machineCode}          ← 客户端调用
 * POST /admin/cards     {count, days, sub}           ← 供应商批量发卡（需 ADMIN_TOKEN）
 * GET  /admin/cards?limit=50                         ← 查看已发卡（需 ADMIN_TOKEN）
 * ```
 *
 * ## 启动
 * ```bash
 * LICENSE_KEY_FILE=./license-private.pem \
 * ADMIN_TOKEN=<自己定一个长随机串> \
 * PORT=8787 \
 * node server.mjs
 * ```
 *
 * ## 证书格式必须与客户端逐字节一致
 * 客户端 `server/utils/license/certificate.ts` 的约定：
 * ```
 * body = base64url(JSON.stringify(payload))      // 字段顺序 v,lic,sub,fp,feat,iat,exp,grace
 * sig  = Ed25519_sign(body 的 UTF-8 字节)         // 签的是 body 字符串，不是 JSON 原文
 * cert = body + '.' + base64url(sig)
 * ```
 * ⚠️ 这里**不能**随意改字段顺序/单位/宽限期算法，否则客户端验签或有效期判定会失败。
 */
import { createHash, randomInt, sign, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'

// ───────────────────────────── 配置 ─────────────────────────────

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '0.0.0.0'
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '').trim()
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
const CARDS_FILE = join(DATA_DIR, 'cards.json')

/** 默认有效天数（发卡时没指定就用它） */
const DEFAULT_DAYS = 365
/** 离线宽限天数：与客户端约定一致（exp 之后还允许用 14 天） */
const GRACE_DAYS = 14
/** 卡密字符集：去掉容易看错的 I O 0 1 */
const CARD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
/** /activate 限流：同一 IP 每分钟最多尝试次数（防暴力猜卡密） */
const RATE_LIMIT_PER_MIN = 20

// ───────────────────────────── 私钥 ─────────────────────────────

function loadPrivateKeyPem() {
  const inline = String(process.env.LICENSE_PRIVATE_KEY_PEM || '').trim()
  if (inline) return inline.replace(/\\n/g, '\n')
  const file = String(process.env.LICENSE_KEY_FILE || '').trim()
  if (file && existsSync(file)) return readFileSync(file, 'utf8')
  // 兜底：当前目录下的 license-private.pem
  const local = join(process.cwd(), 'license-private.pem')
  if (existsSync(local)) return readFileSync(local, 'utf8')
  return ''
}

const PRIVATE_KEY_PEM = loadPrivateKeyPem()

// ───────────────────────────── 卡密台账 ─────────────────────────────

mkdirSync(DATA_DIR, { recursive: true })

/** 内存态台账；每次改动后整体落盘（写临时文件再 rename，避免写一半断电损坏） */
let store = { cards: {}, meta: { createdAt: new Date().toISOString() } }

function loadStore() {
  try {
    const raw = readFileSync(CARDS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.cards) store = parsed
  } catch {
    // 文件不存在或损坏：保持空台账。损坏时不应静默覆盖 —— 先把坏文件备份掉
    if (existsSync(CARDS_FILE)) {
      try {
        renameSync(CARDS_FILE, `${CARDS_FILE}.broken-${Date.now()}`)
        log('⚠️ cards.json 解析失败，已备份为 .broken-* 并新建空台账')
      } catch {
        log('⚠️ cards.json 解析失败且备份失败，本次使用空台账（不会覆盖原文件，除非有新发卡）')
      }
    }
  }
}

function saveStore() {
  const tmp = `${CARDS_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
  renameSync(tmp, CARDS_FILE)
}

loadStore()

// ───────────────────────────── 工具函数 ─────────────────────────────

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

function b64u(buf) {
  return Buffer.from(buf).toString('base64url')
}

/** 生成卡密：TH-XXXX-XXXX */
function genCard() {
  let s = ''
  for (let i = 0; i < 8; i++) s += CARD_ALPHABET[randomInt(CARD_ALPHABET.length)]
  return `TH-${s.slice(0, 4)}-${s.slice(4, 8)}`
}

/** 归一卡密：去空白、转大写、补回连字符（用户手抄常丢横线） */
function normalizeCard(raw) {
  const clean = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!/^TH[A-Z0-9]{8}$/.test(clean)) return ''
  return `TH-${clean.slice(2, 6)}-${clean.slice(6, 10)}`
}

/** 机器码归一：16 位 hex（与客户端 normalizeMachineCode 同口径） */
function normalizeMachineCode(raw) {
  const hex = String(raw ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase()
  return /^[0-9a-f]{16}$/.test(hex) ? hex : ''
}

/** 许可证编号（内部记账用） */
function genLicId() {
  const pick = () => CARD_ALPHABET[randomInt(CARD_ALPHABET.length)]
  return `TH-${pick()}${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}${pick()}`
}

/** 恒定时间比较（防时序侧信道猜 ADMIN_TOKEN） */
function tokenOk(headerValue) {
  const got = Buffer.from(String(headerValue || '').replace(/^Bearer\s+/i, '').trim())
  const want = Buffer.from(ADMIN_TOKEN)
  if (!want.length || got.length !== want.length) return false
  return timingSafeEqual(got, want)
}

/**
 * **签发证书**（与客户端 `certificate.ts` 的 signCertificate 逐字节一致）
 * @param {{days:number, sub:string}} cardMeta
 * @param {string} fp 16 位小写 hex
 */
function issueCertificate(cardMeta, fp) {
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
    grace: now + (days + GRACE_DAYS) * 86400,
  }
  const body = b64u(JSON.stringify(payload))
  // 客户端 verify 的是 body 这段字符串的字节，所以这里也必须签 body（不是 JSON 原文）
  const sig = sign(null, Buffer.from(body, 'utf8'), PRIVATE_KEY_PEM)
  return { certificate: `${body}.${sig.toString('base64url')}`, payload }
}

// ───────────────────────────── 限流 ─────────────────────────────

const rateMap = new Map()

function rateLimited(ip) {
  const now = Date.now()
  const win = Math.floor(now / 60000)
  const key = `${ip}|${win}`
  const n = (rateMap.get(key) || 0) + 1
  rateMap.set(key, n)
  // 顺手清理过期窗口，防止 map 无限增长
  if (rateMap.size > 5000) {
    for (const k of rateMap.keys()) {
      if (!k.endsWith(`|${win}`)) rateMap.delete(k)
    }
  }
  return n > RATE_LIMIT_PER_MIN
}

// ───────────────────────────── HTTP ─────────────────────────────

function readJson(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 64 * 1024) req.destroy() // 64KB 上限：这些接口只收几个短字段
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function send(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    // 只给客户端（本地 Nitro）调用，不需要浏览器 CORS；但开着便于用 curl 调试
    'Access-Control-Allow-Origin': '*',
  })
  res.end(body)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const path = url.pathname
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()

  // 健康检查
  if (req.method === 'GET' && path === '/health') {
    return send(res, 200, {
      ok: true,
      keyLoaded: Boolean(PRIVATE_KEY_PEM),
      cardsTotal: Object.keys(store.cards).length,
      time: new Date().toISOString(),
    })
  }

  // 激活
  if (req.method === 'POST' && path === '/activate') {
    if (rateLimited(ip)) return send(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' })
    const body = await readJson(req)
    const card = normalizeCard(body.card)
    const fp = normalizeMachineCode(body.machineCode)
    if (!card) return send(res, 400, { ok: false, error: '卡密格式不正确（应为 TH-XXXX-XXXX）' })
    if (!fp) return send(res, 400, { ok: false, error: '机器码格式不正确（应为 16 位十六进制）' })
    if (!PRIVATE_KEY_PEM) return send(res, 500, { ok: false, error: '服务端未配置私钥，无法签发' })

    const meta = store.cards[card]
    if (!meta) {
      log('激活失败：卡密不存在', { card, ip })
      return send(res, 404, { ok: false, error: '卡密不存在，请核对是否输入有误' })
    }
    if (meta.usedAt) {
      log('激活失败：卡密已使用', { card, ip })
      return send(res, 409, { ok: false, error: '这张卡密已被使用过了' })
    }

    const { certificate, payload } = issueCertificate(meta, fp)
    meta.usedAt = new Date().toISOString()
    meta.usedBy = fp
    meta.licId = payload.lic
    try {
      saveStore()
    } catch (err) {
      // 落盘失败：证书已经签好了，但卡密没标记为已用 —— 必须让请求失败，否则同一张卡可以无限用
      log('🚨 台账写入失败，拒绝本次激活', { card, error: err instanceof Error ? err.message : String(err) })
      return send(res, 500, { ok: false, error: '服务端台账写入失败，请稍后重试' })
    }
    log('激活成功', { card, lic: payload.lic, exp: payload.exp })
    return send(res, 200, {
      ok: true,
      certificate,
      lic: payload.lic,
      sub: payload.sub,
      exp: payload.exp,
      grace: payload.grace,
    })
  }

  // 管理：发卡
  if (req.method === 'POST' && path === '/admin/cards') {
    if (!tokenOk(req.headers.authorization)) return send(res, 401, { ok: false, error: '未授权' })
    const body = await readJson(req)
    const count = Math.min(Math.max(Math.floor(Number(body.count) || 1), 1), 500)
    const days = Math.floor(Number(body.days) || DEFAULT_DAYS)
    const sub = String(body.sub || '').trim() || '用户'

    const made = []
    for (let i = 0; i < count; i++) {
      let card = genCard()
      // 极端情况下撞号：重新生成（8 位 32 进制 ≈ 1.1e12，基本不会发生）
      while (store.cards[card]) card = genCard()
      store.cards[card] = { card, days, sub, createdAt: new Date().toISOString(), usedAt: null, usedBy: null, licId: null }
      made.push(card)
    }
    saveStore()
    log(`发放 ${made.length} 张卡（${days} 天）`)
    return send(res, 200, { ok: true, count: made.length, days, sub, cards: made })
  }

  // 管理：查卡
  if (req.method === 'GET' && path === '/admin/cards') {
    if (!tokenOk(req.headers.authorization)) return send(res, 401, { ok: false, error: '未授权' })
    const limit = Math.min(Math.max(Math.floor(Number(url.searchParams.get('limit')) || 100), 1), 2000)
    const all = Object.values(store.cards)
    const unused = all.filter((c) => !c.usedAt)
    const used = all.filter((c) => c.usedAt)
    return send(res, 200, {
      ok: true,
      total: all.length,
      unusedCount: unused.length,
      usedCount: used.length,
      unused: unused.slice(-limit).map((c) => ({ card: c.card, days: c.days, createdAt: c.createdAt })),
      used: used.slice(-limit).map((c) => ({ card: c.card, days: c.days, usedAt: c.usedAt, usedBy: c.usedBy, licId: c.licId })),
    })
  }

  send(res, 404, { ok: false, error: 'Not Found' })
})

// ───────────────────────────── 启动 ─────────────────────────────

if (!PRIVATE_KEY_PEM) {
  console.error('')
  console.error('❌ 没有加载到私钥。请用下面任一方式提供：')
  console.error('   LICENSE_KEY_FILE=/path/to/license-private.pem')
  console.error('   LICENSE_PRIVATE_KEY_PEM="-----BEGIN PRIVATE KEY-----\\n..."')
  console.error('   或把 license-private.pem 放在当前工作目录')
  console.error('')
  process.exit(1)
}
if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 16) {
  console.error('')
  console.error('❌ ADMIN_TOKEN 未设置或太短（至少 16 位）。发卡接口靠它保护，必须设。')
  console.error('   生成一个：node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"')
  console.error('')
  process.exit(1)
}

server.listen(PORT, HOST, () => {
  const keyFp = createHash('sha256')
    .update(String(PRIVATE_KEY_PEM).split('\n').slice(1, -2).join(''))
    .digest('hex')
    .slice(0, 12)
    .toUpperCase()
  log('──────────────────────────────────────────────')
  log('  授权激活服务已启动')
  log(`  监听      : http://${HOST}:${PORT}`)
  log(`  私钥指纹  : ${keyFp}  ← 与签发工具显示的指纹对比，一致才是同一把钥匙`)
  log(`  台账文件  : ${CARDS_FILE}`)
  log(`  已发卡    : ${Object.keys(store.cards).length} 张`)
  log('──────────────────────────────────────────────')
})
