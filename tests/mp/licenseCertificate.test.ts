/**
 * 许可证**证书层**单测（2026-10-16）
 *
 * 为什么值得单测：这一层是整套授权的**唯一安全边界**。上面那三类错误都不会有编译期或运行期报错 ——
 *   · 验签写反/写漏 ⇒ "谁都能用"（静默失效，最危险）；
 *   · 机器码比对漏掉 ⇒ "一张证书全校通用"；
 *   · 宽限期算错 ⇒ "授权永不过期"。
 * 所以每条拒绝路径都必须有一条**可执行**的断言钉住，且**正路径**也要有（否则"全拒绝"也会让测试全绿）。
 *
 * ⚠️ 测试**自己生成一对临时密钥**（`generateKeyPairSync`），不依赖仓库里的真实私钥 ——
 *    真实私钥在 `tools/keys/`（已 gitignore，CI 上根本没有），测试绝不能依赖它。
 */
import { generateKeyPairSync } from 'node:crypto'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  b64uDecode,
  b64uEncode,
  decodeCertificate,
  formatMachineCode,
  isLicensePayload,
  issueCertificate,
  normalizeMachineCode,
  signCertificate,
  verifyCertificate,
} from '../../server/utils/license/certificate.ts'
import type { LicensePayload } from '../../server/utils/license/certificate.ts'

/** 测试用密钥对（每次运行都不同 ⇒ 顺带证明"别人的密钥签的证书验不过"） */
function makeKeys(): { pub: string; priv: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

const FP = 'a1b2c3d4e5f60718'
const DAY = 86400

test('正路径：签发 → 验签通过，且字段如实落进载荷', () => {
  const { pub, priv } = makeKeys()
  const { certificate, payload } = issueCertificate({ lic: 'TH-TEST-0001', sub: '张三', fingerprint: FP, days: 30 }, priv)

  const r = verifyCertificate(certificate, pub, { fingerprint: FP })
  assert.equal(r.ok, true)
  assert.equal(r.code, 'ok')
  assert.equal(r.degraded, false, '30 天有效期内不该是降级状态')
  assert.equal(r.payload?.sub, '张三')
  assert.equal(r.payload?.lic, 'TH-TEST-0001')
  assert.equal(r.payload?.fp, FP)
  // 离线宽限改为「到期后再给半天」（2026-10-20：原来 14 天太长，过期形同虚设）
  assert.equal(payload.grace - payload.exp, 12 * 60 * 60, '离线宽限应恰好比正常到期晚 12 小时（半天）')
})

test('正路径：机器码大小写/连字符不敏感（用户复制粘贴的形态都能对上）', () => {
  const { pub, priv } = makeKeys()
  const { certificate } = issueCertificate({ lic: 'TH-X', sub: 's', fingerprint: FP, days: 30 }, priv)
  // ⚠️ 注意：FP(`…0718`) 与 `A1B2-C3D4-E5F6-7890`(归一化后 `…7890`) 是**两个不同的值**，别当成同一个
  assert.equal(normalizeMachineCode('A1B2-C3D4-E5F6-7890'), 'a1b2c3d4e5f67890')
  assert.equal(normalizeMachineCode('A1B2-C3D4-E5F6-0718'), FP)
  assert.equal(formatMachineCode(FP), 'A1B2-C3D4-E5F6-0718')
  // 用**显示形态**（大写 + 连字符）当机器码传入也必须验得过 ⇒ 证明"证书侧/本机侧"都做了归一化
  assert.equal(verifyCertificate(certificate, pub, { fingerprint: 'A1B2-C3D4-E5F6-0718' }).ok, true)
})

test('篡改载荷（重编码但不重新签名）⇒ bad_signature', () => {
  const { pub, priv } = makeKeys()
  const { certificate } = issueCertificate({ lic: 'TH-X', sub: '张三', fingerprint: FP, days: 30 }, priv)
  const [body, sig] = certificate.split('.')

  // 把授权对象从"张三"改成"李四"，签名沿用旧的 ⇒ 必须被拒
  const raw = JSON.parse(b64uDecode(body)!.toString('utf8')) as LicensePayload
  raw.sub = '李四'
  const tampered = `${b64uEncode(JSON.stringify(raw))}.${sig}`

  const r = verifyCertificate(tampered, pub, { fingerprint: FP })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'bad_signature')
})

test('篡改签名 ⇒ bad_signature', () => {
  const { pub, priv } = makeKeys()
  const { certificate } = issueCertificate({ lic: 'TH-X', sub: 's', fingerprint: FP, days: 30 }, priv)
  const [body, sig] = certificate.split('.')
  /**
   * ⚠️ **必须改签名的中段，不能改最后一个字符**（这里踩过一次 flaky，值得记下来）：
   * Ed25519 签名是 64 字节 = 512 bit，base64url 编成 86 个字符，最后一个字符只承载 **2 个有效 bit**
   * （其余 4 bit 必须补零）。所以末位 `A`→`B` 解出来的字节**完全一样**、签名根本没被改动，
   * 验证自然还是通过 ⇒ 断言随机地失败。中段的字符承载完整 6 bit，改动必然改变签名字节。
   */
  const at = 10
  const flipped = sig.slice(0, at) + (sig[at] === 'A' ? 'B' : 'A') + sig.slice(at + 1)
  assert.notEqual(flipped, sig, '篡改后必须与原签名不同（否则这个用例等于没测）')
  assert.equal(verifyCertificate(`${body}.${flipped}`, pub, { fingerprint: FP }).code, 'bad_signature')
})

test('**别人的私钥**签的证书 ⇒ bad_signature（伪造不可行）', () => {
  const mine = makeKeys()
  const attacker = makeKeys()
  const { certificate } = issueCertificate({ lic: 'TH-EVIL', sub: '攻击者', fingerprint: FP, days: 3650 }, attacker.priv)
  // 用**真正的公钥**去验攻击者签的证书
  assert.equal(verifyCertificate(certificate, mine.pub, { fingerprint: FP }).code, 'bad_signature')
})

test('机器码不匹配 ⇒ fingerprint_mismatch（挡住"把证书拷给别人"）', () => {
  const { pub, priv } = makeKeys()
  const { certificate } = issueCertificate({ lic: 'TH-X', sub: 's', fingerprint: FP, days: 30 }, priv)
  const r = verifyCertificate(certificate, pub, { fingerprint: 'ffffffffffffffff' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'fingerprint_mismatch')
  // 即使被拒，也应把载荷带回来（界面要能显示"这张证书是给谁的"）
  assert.equal(r.payload?.fp, FP)
})

test('到期但在**离线宽限内** ⇒ 放行且 degraded=true；超宽限 ⇒ grace_expired', () => {
  const { pub, priv } = makeKeys()
  const nowMs = Date.UTC(2026, 0, 1)
  const { certificate, payload } = issueCertificate({ lic: 'TH-X', sub: 's', fingerprint: FP, days: 30, nowMs }, priv)

  // ① 正常期内
  const inTerm = verifyCertificate(certificate, pub, { fingerprint: FP, nowMs: nowMs + 10 * DAY * 1000 })
  assert.equal(inTerm.ok, true)
  assert.equal(inTerm.degraded, false)

  // ② 过了 exp、还在 grace 内 ⇒ 仍放行，但标记降级（界面据此提示"请尽快续期"）
  const inGrace = verifyCertificate(certificate, pub, { fingerprint: FP, nowMs: (payload.exp + 1) * 1000 })
  assert.equal(inGrace.ok, true, '宽限期内必须仍可用 —— 这是"首次激活后能离线用"的前提')
  assert.equal(inGrace.degraded, true)

  // ③ 超过 grace ⇒ 硬停
  const expired = verifyCertificate(certificate, pub, { fingerprint: FP, nowMs: (payload.grace + 30 * DAY) * 1000 })
  assert.equal(expired.ok, false)
  assert.equal(expired.code, 'grace_expired')
})

test('时钟偏差容差：刚刚到期的边界不应因为秒级时差被误杀', () => {
  const { pub, priv } = makeKeys()
  const nowMs = Date.UTC(2026, 0, 1)
  const { certificate, payload } = issueCertificate({ lic: 'TH-X', sub: 's', fingerprint: FP, days: 1, nowMs }, priv)
  // ① 刚过 grace 1 小时：仍在 24 小时时钟容差内 ⇒ **仍放行**（不因两边时钟差几秒就把用户挡在门外）
  const withinSkew = verifyCertificate(certificate, pub, { fingerprint: FP, nowMs: (payload.grace + 3600) * 1000 })
  assert.equal(withinSkew.ok, true, '24 小时时钟容差内不应误杀')
  // ② 超过 grace 25 小时：超出容差 ⇒ 必须硬停
  const beyond = verifyCertificate(certificate, pub, { fingerprint: FP, nowMs: (payload.grace + 25 * 3600) * 1000 })
  assert.equal(beyond.ok, false)
  assert.equal(beyond.code, 'grace_expired')
})

test('格式错误 ⇒ malformed（空串 / 缺分隔符 / 非 base64url / 载荷不是 JSON）', () => {
  const { pub, priv } = makeKeys()
  const { certificate } = issueCertificate({ lic: 'TH-X', sub: 's', fingerprint: FP, days: 30 }, priv)
  const sig = certificate.split('.')[1]

  assert.equal(verifyCertificate('', pub, { fingerprint: FP }).code, 'malformed')
  assert.equal(verifyCertificate('没有点的字符串', pub, { fingerprint: FP }).code, 'malformed')
  assert.equal(verifyCertificate(`.${sig}`, pub, { fingerprint: FP }).code, 'malformed')
  assert.equal(verifyCertificate(`${certificate.split('.')[0]}.`, pub, { fingerprint: FP }).code, 'malformed')
  // 合法 base64url 但载荷不是 JSON
  assert.equal(verifyCertificate(`${b64uEncode('not json at all')}.${sig}`, pub, { fingerprint: FP }).code, 'malformed')
})

test('载荷结构非法 ⇒ malformed（含"宽限早于到期"这种顺序错误）', () => {
  const { pub, priv } = makeKeys()
  const now = Math.floor(Date.now() / 1000)
  const bad: LicensePayload = { v: 1, lic: 'TH-X', sub: 's', fp: FP, feat: ['pro'], iat: now, exp: now + 10 * DAY, grace: now + DAY }

  assert.equal(isLicensePayload(bad), false, 'grace < exp 必须被判非法（否则"降级放行"区间是反的）')
  // 用**合法签名**包一个**非法载荷**：验签能过，但结构校验必须先拦下
  assert.equal(verifyCertificate(signCertificate(bad, priv), pub, { fingerprint: FP }).code, 'malformed')

  // 缺字段 / 版本号不对 / 机器码形状不对
  assert.equal(isLicensePayload({ ...bad, fp: 'zzzz' }), false)
  assert.equal(isLicensePayload({ ...bad, grace: undefined }), false)
  assert.equal(isLicensePayload({ ...bad, v: 2 }), false)
  assert.equal(isLicensePayload(null), false)
  assert.equal(isLicensePayload('字符串'), false)
})

test('**公钥为空 = 拒绝一切**（fail closed：绝不允许"没配公钥就放行"）', () => {
  const { priv } = makeKeys()
  const { certificate } = issueCertificate({ lic: 'TH-X', sub: 's', fingerprint: FP, days: 30 }, priv)
  for (const empty of ['', '   ', '\n']) {
    const r = verifyCertificate(certificate, empty, { fingerprint: FP })
    assert.equal(r.ok, false, '空公钥绝不能放行')
    assert.equal(r.code, 'no_public_key')
  }
})

test('公钥本身被改坏 ⇒ bad_signature（不是崩溃、更不是放行）', () => {
  const { priv } = makeKeys()
  const { certificate } = issueCertificate({ lic: 'TH-X', sub: 's', fingerprint: FP, days: 30 }, priv)
  const r = verifyCertificate(certificate, '-----BEGIN PUBLIC KEY-----\n坏掉的公钥\n-----END PUBLIC KEY-----\n', {
    fingerprint: FP,
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'bad_signature')
})

test('粘贴容错：换行/空格/制表符会被忽略（用户从聊天窗口复制常带这些）', () => {
  const { pub, priv } = makeKeys()
  const { certificate } = issueCertificate({ lic: 'TH-X', sub: 's', fingerprint: FP, days: 30 }, priv)
  const messy = `  ${certificate.slice(0, 10)}\n${certificate.slice(10, 40)} \t ${certificate.slice(40)}  \n\n`
  const r = verifyCertificate(messy, pub, { fingerprint: FP })
  assert.equal(r.ok, true, '带换行/空格粘贴也必须能激活')
})

test('decodeCertificate：不验签也能读出载荷（供界面显示"证书是给谁的"）', () => {
  const { priv } = makeKeys()
  const { certificate } = issueCertificate({ lic: 'TH-ABC-1234', sub: '李四', fingerprint: FP, days: 30 }, priv)
  const decoded = decodeCertificate(certificate)
  assert.equal(decoded?.sub, '李四')
  assert.equal(decoded?.lic, 'TH-ABC-1234')
  assert.equal(decodeCertificate('垃圾'), null)
})

test('机器码归一化：只认 16 位 hex，长度不对一律返回空串（不做猜测性修补）', () => {
  assert.equal(normalizeMachineCode('a1b2c3d4e5f60718'), FP)
  assert.equal(normalizeMachineCode('A1B2-C3D4-E5F6-0718'), FP)
  assert.equal(normalizeMachineCode(' a1b2 c3d4 e5f6 0718 '), FP)
  for (const bad of ['', 'abc', 'a1b2c3d4e5f60718ff', 'zzzzzzzzzzzzzzzz', null, undefined, 123]) {
    assert.equal(normalizeMachineCode(bad), '', `应拒绝：${JSON.stringify(bad)}`)
  }
  assert.equal(formatMachineCode('nope'), '')
})
