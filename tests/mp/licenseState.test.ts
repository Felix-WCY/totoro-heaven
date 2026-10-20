/**
 * 许可证**状态层**单测（2026-10-16）
 *
 * 覆盖的是"落盘与状态机"这部分（不是验签本身 —— 验签在 `licenseCertificate.test.ts` 里全面覆盖）。
 * 三条最值得钉住的不变量：
 *  ① **激活失败绝不落盘** —— 把坏证书写进 license.json 会变成"以后每次启动都报错、还难查"的隐性问题；
 *  ② **文件损坏也不能崩** —— 授权状态坏了不该让整个程序起不来（应退化为"未激活"）；
 *  ③ **机器码在同一次安装内稳定** —— 否则用户每次开机都要重新激活（会被当成 bug 反复报）。
 *
 * ⚠️ 数据目录必须在**导入模块之前**设好：`instance.ts` 在模块加载时就把 `LICENSE_DIR` 求值了
 *    （刻意的：路径是常量，不该每次调用重算）⇒ 本文件用**动态 import**，不能用顶部静态 import。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

/** 测试用授权目录（**绝不能碰用户真实的 %LOCALAPPDATA%**） */
const TEST_DIR = join(tmpdir(), `totoro-license-test-${process.pid}-${Date.now()}`)
process.env.TOTORO_LICENSE_DIR = TEST_DIR

const instance = await import('../../server/utils/license/instance.ts')
const state = await import('../../server/utils/license/state.ts')
const publicKey = await import('../../server/utils/license/publicKey.ts')

const LICENSE_FILE = join(TEST_DIR, 'license.json')

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

test('初始状态：未激活、拿得到机器码、数据目录指向测试目录', () => {
  const s = state.getLicenseStatus(true)
  assert.equal(s.licensed, false)
  assert.equal(s.code, 'not_activated')
  assert.equal(s.dir, TEST_DIR, '必须落在被 TOTORO_LICENSE_DIR 覆盖的目录，绝不碰真实用户目录')
  assert.match(s.machineCode, /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/, '机器码应是 XXXX-XXXX-XXXX-XXXX')
  assert.equal(s.machineCodeStable, true, '本机目录可写 ⇒ 机器码应已持久化')
})

test('机器码在同一安装内稳定（连续调用不变）', () => {
  const a = instance.machineFingerprint()
  const b = instance.machineFingerprint()
  assert.equal(a, b, '同一次运行里机器码必须恒定，否则授权会随机失效')
  assert.match(a, /^[0-9a-f]{16}$/)
  // 显示形态与指纹必须同源（否则"发给供应商的机器码"和"证书里绑的"会对不上）
  assert.equal(instance.machineCode().replace(/-/g, '').toLowerCase(), a)
})

test('实例 ID 落盘且可复读（持久化 = 换系统/清临时目录不会作废授权）', () => {
  const first = instance.getInstanceId()
  assert.equal(first.persisted, true)
  assert.ok(existsSync(join(TEST_DIR, 'instance-id')), '实例 ID 必须落盘')
  const second = instance.getInstanceId()
  assert.equal(second.id, first.id)
})

test('**激活失败绝不落盘**：坏证书被拒，且不产生授权文件', () => {
  const r = state.activateLicense('这不是一张证书')
  assert.equal(r.ok, false)
  assert.ok(r.error.length > 0, '必须给出面向用户的原因')
  assert.equal(existsSync(LICENSE_FILE), false, '失败时写盘 = 以后每次启动都报错，绝不允许')
  assert.equal(state.getLicenseStatus(true).licensed, false)
})

test('空证书给出"请先粘贴"的明确提示（而不是模糊报错）', () => {
  const r = state.activateLicense('   ')
  assert.equal(r.ok, false)
  assert.match(r.error, /粘贴/)
  assert.equal(existsSync(LICENSE_FILE), false)
})

test('公钥配置状态与源码一致；未配置时必须是"拒绝一切"（fail closed）', () => {
  const s = state.getLicenseStatus(true)
  assert.equal(s.publicKeyConfigured, Boolean(publicKey.LICENSE_PUBLIC_KEY_PEM.trim()))
  if (!s.publicKeyConfigured) {
    // 未配置公钥时，任何"看起来像证书"的输入都不能被接受
    assert.equal(state.activateLicense('aaaa.bbbb').ok, false)
  }
})

test('按**强制校验**口径运行（非 Nitro dev 构建下 devBypass 必须为 false）', () => {
  const s = state.getLicenseStatus(true)
  assert.equal(s.devBypass, false, '普通 Node 进程不是开发模式 ⇒ 绝不能绕过校验')
  assert.equal(s.enforced, true)
})

test('授权文件损坏时不崩溃，退化为"未激活"', () => {
  mkdirSync(TEST_DIR, { recursive: true })
  writeFileSync(LICENSE_FILE, '{ 这不是合法 JSON', 'utf8')
  const s = state.getLicenseStatus(true)
  assert.equal(s.licensed, false, '坏文件应退化为未激活，而不是抛错让服务起不来')
  assert.equal(s.code, 'not_activated')
})

test('授权文件结构不对（缺 certificate 字段）同样退化为"未激活"', () => {
  writeFileSync(LICENSE_FILE, JSON.stringify({ v: 1, machineCode: 'x', activatedAt: '' }), 'utf8')
  assert.equal(state.getLicenseStatus(true).licensed, false)
})

test('解绑是**幂等**的：没有授权文件时同样成功，状态回到未激活', () => {
  rmSync(LICENSE_FILE, { force: true })
  const first = state.deactivateLicense()
  const second = state.deactivateLicense()
  assert.equal(first.licensed, false)
  assert.equal(second.code, 'not_activated')
  assert.equal(existsSync(LICENSE_FILE), false)
})

test('本地存的证书即使合法也**不会**因为"文件在"就放行（仍要过验签与机器码）', () => {
  // 塞一张结构正确但签名是瞎写的证书：必须被拒（证明"落盘"本身不等于"已授权"）
  writeFileSync(
    LICENSE_FILE,
    JSON.stringify({ v: 1, certificate: 'eyJ2IjoxfQ.AAAA', machineCode: 'ffffffffffffffff', activatedAt: '' }),
    'utf8',
  )
  const s = state.getLicenseStatus(true)
  assert.equal(s.licensed, false)
  // `state_tampered`：手写的文件没有本地状态校验码（2026-10-20 加），同样按拒绝处理
  assert.ok(
    ['bad_signature', 'malformed', 'fingerprint_mismatch', 'no_public_key', 'state_tampered'].includes(s.code),
    `实际：${s.code}`,
  )
})

test('手改本地状态（lastSeenMs）会被判定为篡改并拒绝', () => {
  // 模拟"买家编辑 license.json 把已用时间调小以续命"：签名对不上 ⇒ state_tampered
  writeFileSync(
    LICENSE_FILE,
    JSON.stringify({
      v: 1,
      certificate: 'eyJ2IjoxfQ.AAAA',
      machineCode: 'ffffffffffffffff',
      activatedAt: '2026-01-01T00:00:00.000Z',
      lastSeenMs: 1, // ← 被调到很久以前
      stateMac: 'deadbeefdeadbeefdeadbeefdeadbeef',
    }),
    'utf8',
  )
  const s = state.getLicenseStatus(true)
  assert.equal(s.licensed, false)
  assert.equal(s.code, 'state_tampered')
})

test('licenseFilePath() 与数据目录一致（排查时不至于指错地方）', () => {
  assert.equal(state.licenseFilePath(), LICENSE_FILE)
})
