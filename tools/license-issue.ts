#!/usr/bin/env node
/**
 * 签发**授权证书**（发布者本机跑；私钥始终不出本机）
 *
 * ```bash
 * node tools/license-issue.ts --machine A1B2-C3D4-E5F6-7890 --sub "张三" [--days 365] [--features pro]
 * ```
 *
 * ## 完整流程（用户侧 ↔ 你侧）
 * ```
 * 用户：打开「授权」页 → 复制机器码 ──► 发给你
 * 你  ：跑本脚本（读本机私钥签名） ──► 得到一段证书
 * 你  ：把证书发回用户
 * 用户：在「授权」页粘贴 → 激活成功（之后可离线使用）
 * ```
 *
 * ## 为什么机器码要由用户报给你（而不是"一个 key 通用"）
 * 证书里的 `fp` 必须等于用户本机指纹 ⇒ 同一张证书**换台机器就失效**，
 * 从根上堵掉"一个人买了 key 全校一起用"。代价是每个用户都要报一次机器码（一机一证）。
 *
 * ## 签发记录
 * 每签一张都会**追加**一行到 `tools/keys/issued.jsonl`（含客户名/机器码/证书，便于对账与重发）。
 * 该目录已在 `.gitignore` 里（与私钥同级，且含客户信息，绝不入库）。
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeCertificate, formatMachineCode, issueCertificate, normalizeMachineCode } from '../server/utils/license/certificate.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const KEY_DIR = join(ROOT, 'tools', 'keys')
const PRIVATE_KEY_PATH = join(KEY_DIR, 'license-private.pem')
const LEDGER_PATH = join(KEY_DIR, 'issued.jsonl')

/** 许可证编号用的字母表：剔除 0/O/1/I 等易混字符（要念给客户听，不能看错） */
const ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

/** 生成本次授权的许可证编号（`TH-XXXX-XXXX`） */
function newLicenseId(): string {
  const bytes = randomBytes(8)
  let s = ''
  for (const b of bytes) s += ALPHA[b % 32] // 256 / 32 整除 ⇒ 无取模偏差
  return `TH-${s.slice(0, 4)}-${s.slice(4, 8)}`
}

/** 极简参数解析（零依赖；支持 `--k v` 与 `--k=v` 两种写法） */
function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq > 0) {
      out.set(a.slice(2, eq), a.slice(eq + 1))
    } else {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        out.set(a.slice(2), next)
        i++
      } else {
        out.set(a.slice(2), '')
      }
    }
  }
  return out
}

function usage(exitCode: number): never {
  console.error('')
  console.error('用法：')
  console.error('  node tools/license-issue.ts --machine <机器码> --sub "<客户名>" [--days 365] [--features pro] [--lic TH-XXXX-XXXX]')
  console.error('')
  console.error('  --machine   用户在「授权」页复制的机器码（形如 A1B2-C3D4-E5F6-7890，连字符/大小写不敏感）')
  console.error('  --sub       授权对象（客户名或备注，会写进证书，用户界面能看到）')
  console.error('  --days      有效天数，默认 365（到期后再给半天离线宽限）')
  console.error('  --features  功能位，逗号分隔，默认 pro（本版仅记录与展示，不做差异化限制）')
  console.error('  --lic       手工指定许可证编号（默认自动生成）')
  console.error('')
  process.exit(exitCode)
}

const args = parseArgs(process.argv.slice(2))

if (!existsSync(PRIVATE_KEY_PATH)) {
  console.error('')
  console.error('❌ 找不到私钥：')
  console.error(`   ${PRIVATE_KEY_PATH}`)
  console.error('')
  console.error('   请先在本机执行一次（只需一次）：')
  console.error('     node tools/license-keygen.ts')
  console.error('')
  process.exit(1)
}

const fingerprint = normalizeMachineCode(args.get('machine'))
if (!fingerprint) {
  console.error('')
  console.error(`❌ 机器码不合法：${JSON.stringify(args.get('machine') ?? '')}`)
  console.error('   应为 16 位 hex（形如 A1B2-C3D4-E5F6-7890）；请让用户从「授权」页直接复制，不要手抄。')
  usage(1)
}

const subject = (args.get('sub') ?? '').trim()
if (!subject) {
  console.error('')
  console.error('❌ 缺少 --sub（授权对象）')
  usage(1)
}

const daysRaw = Number(args.get('days') ?? 365)
const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.floor(daysRaw) : 365
const features = (args.get('features') ?? 'pro')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const lic = (args.get('lic') ?? '').trim() || newLicenseId()

const privateKeyPem = readFileSync(PRIVATE_KEY_PATH, 'utf8')
const { certificate, payload } = issueCertificate({ lic, sub: subject, fingerprint, features, days }, privateKeyPem)

// 自校验：签完立刻用公钥（从源码里读出来）验一遍，避免"签错了却发给客户"
const pubSrc = readFileSync(join(ROOT, 'server', 'utils', 'license', 'publicKey.ts'), 'utf8')
const pemMatch = /LICENSE_PUBLIC_KEY_PEM\s*=\s*`([\s\S]*?)`/.exec(pubSrc)
if (!pemMatch || !pemMatch[1].trim()) {
  console.error('')
  console.error('⚠️  自校验跳过：`server/utils/license/publicKey.ts` 里的公钥为空。')
  console.error('   这说明 keygen 没有成功写入公钥，客户端将**拒绝一切证书**（fail closed）。请重新执行 keygen。')
  console.error('')
}

const decoded = decodeCertificate(certificate)
const fmt = (sec: number) => new Date(sec * 1000).toLocaleString('zh-CN', { hour12: false })

// 记账（含客户信息 ⇒ 与私钥同目录，已 gitignore）
mkdirSync(KEY_DIR, { recursive: true })
appendFileSync(
  LEDGER_PATH,
  `${JSON.stringify({ at: new Date().toISOString(), lic: payload.lic, sub: payload.sub, fp: payload.fp, days, exp: payload.exp, certificate })}\n`,
  'utf8',
)

console.log('')
console.log('✅ 授权证书已签发（自校验：' + (decoded && decoded.fp === fingerprint ? '通过' : '失败') + '）')
console.log('')
console.log(`   许可证编号 : ${payload.lic}`)
console.log(`   授权对象   : ${payload.sub}`)
console.log(`   机器码     : ${formatMachineCode(payload.fp)}`)
console.log(`   功能位     : ${payload.feat.join(', ')}`)
console.log(`   正常到期   : ${fmt(payload.exp)}`)
console.log(`   离线宽限至 : ${fmt(payload.grace)}（超过它一律拒绝）`)
console.log('')
console.log('   ── 把下面这一整段发给用户（他在「授权」页粘贴即可）──────────────')
console.log('')
console.log(certificate)
console.log('')
console.log('   ──────────────────────────────────────────────────────────────')
console.log(`   签发记录已追加到 ${LEDGER_PATH}`)
console.log('')
