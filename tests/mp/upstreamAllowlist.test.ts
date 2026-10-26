/**
 * 上游白名单测试 —— 钉住"哪些学校域名可以走代理"。
 *
 * ## 为什么要有这个测试（真实事故）
 * 2026-10-26：`server/api/mp/[...slug].ts` 的 `ALLOWED_EXACT_HOSTS` 曾被一次
 * **静默失败的字符串替换**清空（命令打印了"已恢复"，但实际没匹配上，也没人校验内容）。
 * 后果：所有租户学校的请求被 `normalizeBase` **静默回落到共享域**，
 * 租户学生的 token 在共享域一律被判「token失效，注册失败」——
 * 表现为"验活成功、紧接着读取全灭"，排查了 4 轮才定位到这个空数组。
 *
 * 所以把白名单抽到 `server/utils/mpUpstream.ts` 并用这里钉死：
 * 5 个租户域必须被放行，未知域必须被拒绝。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KNOWN_SCHOOL_DOMAINS } from '../../utils/mp/schoolGate'
import { isAllowedUpstreamHost, normalizeAllowedBase } from '../../server/utils/mpUpstream'

const FALLBACK = 'https://wxxcx.xtotoro.com'

test('5 个租户域全部允许（少一个就会让对应学校静默失效）', () => {
  assert.equal(KNOWN_SCHOOL_DOMAINS.length, 5, '租户域应有 5 个')
  for (const host of KNOWN_SCHOOL_DOMAINS) {
    assert.equal(isAllowedUpstreamHost(host), true, `应允许 ${host}`)
  }
  // 逐个点名，防止有人把数组改空却仍然"长度对得上"
  for (const host of [
    'yanggpa.ustl.edu.cn', // 辽宁科技大学
    'sunnysport.zjyc.edu.cn',
    'shtc.jscn.edu.cn',
    'sunrun.jsfpc.edu.cn',
    'zhygp.just.edu.cn',
  ]) {
    assert.equal(isAllowedUpstreamHost(host), true, `必须允许 ${host}`)
  }
})

test('共享域及其子域允许，未知域拒绝', () => {
  assert.equal(isAllowedUpstreamHost('wxxcx.xtotoro.com'), true)
  assert.equal(isAllowedUpstreamHost('foo.xtotoro.com'), true)
  assert.equal(isAllowedUpstreamHost('evil.example.com'), false)
  assert.equal(isAllowedUpstreamHost('xtotoro.com.evil.com'), false)
  assert.equal(isAllowedUpstreamHost(''), false)
})

test('normalizeAllowedBase：保留合法租户域，非法回落共享域', () => {
  assert.equal(normalizeAllowedBase('https://yanggpa.ustl.edu.cn', FALLBACK), 'https://yanggpa.ustl.edu.cn')
  assert.equal(normalizeAllowedBase('https://yanggpa.ustl.edu.cn/', FALLBACK), 'https://yanggpa.ustl.edu.cn')
  assert.equal(normalizeAllowedBase('https://yanggpa.ustl.edu.cn/api/x', FALLBACK), 'https://yanggpa.ustl.edu.cn')
  // 明文 / 未知域 / 带凭据 / 垃圾值 一律回落
  assert.equal(normalizeAllowedBase('http://yanggpa.ustl.edu.cn', FALLBACK), FALLBACK)
  assert.equal(normalizeAllowedBase('https://evil.example.com', FALLBACK), FALLBACK)
  assert.equal(normalizeAllowedBase('https://user:pw@yanggpa.ustl.edu.cn', FALLBACK), FALLBACK)
  assert.equal(normalizeAllowedBase('not a url', FALLBACK), FALLBACK)
  assert.equal(normalizeAllowedBase(undefined, FALLBACK), FALLBACK)
})
