/**
 * `utils/mp/clockGuard.ts` 的单测。
 *
 * 重点覆盖"买家调系统时间"这条路：**小幅回拨放过（修正时钟），大幅回拨拒绝**，
 * 且**累计时间只增不减** —— 到期不会因为把时间调回去而重新开始。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  checkClock,
  CLOCK_ROLLBACK_TOLERANCE_MS,
  CLOCK_STATE_MIN_STEP_MS,
  describeRollback,
} from '../../utils/mp/clockGuard.ts'

const HOUR = 3600000
const DAY = 24 * HOUR

test('首次运行（没有历史记录）：放行，并用当前时钟', () => {
  const now = 1_700_000_000_000
  const r = checkClock({ nowMs: now, lastSeenMs: 0 })
  assert.equal(r.ok, true)
  assert.equal(r.rolledBack, false)
  assert.equal(r.effectiveNowMs, now)
  assert.equal(r.rollbackMs, 0)
})

test('时钟正常前进：放行，用当前时钟', () => {
  const last = 1_700_000_000_000
  const now = last + 2 * HOUR
  const r = checkClock({ nowMs: now, lastSeenMs: last })
  assert.equal(r.ok, true)
  assert.equal(r.effectiveNowMs, now)
})

test('小幅回拨（1 小时，容差内）：放行，但累计时间不倒退', () => {
  const last = 1_700_000_000_000
  const now = last - 1 * HOUR
  const r = checkClock({ nowMs: now, lastSeenMs: last })
  assert.equal(r.ok, true, '容差内的回拨应视为"修正时钟"')
  assert.equal(r.rolledBack, false)
  assert.equal(r.effectiveNowMs, last, '累计时间必须取历史最大值，不能倒退')
})

test('大幅回拨（30 天）：拒绝（判定为改系统时间）', () => {
  const last = 1_700_000_000_000
  const now = last - 30 * DAY
  const r = checkClock({ nowMs: now, lastSeenMs: last })
  assert.equal(r.ok, false)
  assert.equal(r.rolledBack, true)
  assert.equal(r.rollbackMs, 30 * DAY)
  assert.equal(r.effectiveNowMs, last, '即使拒绝，累计时间也不倒退')
})

test('回拨正好等于容差：不算回拨（边界按"超过"判定）', () => {
  const last = 1_700_000_000_000
  const now = last - CLOCK_ROLLBACK_TOLERANCE_MS
  const r = checkClock({ nowMs: now, lastSeenMs: last })
  assert.equal(r.rolledBack, false)
  assert.equal(r.ok, true)
})

test('回拨超过容差 1 毫秒：算回拨', () => {
  const last = 1_700_000_000_000
  const now = last - CLOCK_ROLLBACK_TOLERANCE_MS - 1
  const r = checkClock({ nowMs: now, lastSeenMs: last })
  assert.equal(r.rolledBack, true)
  assert.equal(r.ok, false)
})

test('时钟跳到未来：放行，且以未来时间为累计基准（防止再调回去）', () => {
  const last = 1_700_000_000_000
  const now = last + 200 * DAY
  const r = checkClock({ nowMs: now, lastSeenMs: last })
  assert.equal(r.ok, true)
  assert.equal(r.effectiveNowMs, now)

  // 之后把时间调回"真实"时间 ⇒ 会被判为回拨
  const back = checkClock({ nowMs: last + 1 * DAY, lastSeenMs: now })
  assert.equal(back.rolledBack, true)
})

test('shouldPersist：步长不足 1 分钟不写盘，超过才写', () => {
  const last = 1_700_000_000_000
  const same = checkClock({ nowMs: last + 1000, lastSeenMs: last })
  assert.equal(same.shouldPersist, false)

  const advanced = checkClock({ nowMs: last + CLOCK_STATE_MIN_STEP_MS, lastSeenMs: last })
  assert.equal(advanced.shouldPersist, true)

  const rolled = checkClock({ nowMs: last - 30 * DAY, lastSeenMs: last })
  assert.equal(rolled.shouldPersist, false, '回拨时不能把"更早的时间"写回去')
})

test('非法输入不抛异常（NaN / 负数）', () => {
  const r1 = checkClock({ nowMs: Number.NaN, lastSeenMs: 0 })
  assert.equal(r1.ok, true)
  const r2 = checkClock({ nowMs: 1000, lastSeenMs: -5 })
  assert.equal(r2.ok, true)
  assert.equal(r2.effectiveNowMs, 1000)
})

test('describeRollback 说人话', () => {
  assert.equal(describeRollback(0), '无回拨')
  assert.equal(describeRollback(5 * HOUR), '约 5 小时')
  assert.equal(describeRollback(3 * DAY), '约 3 天')
})
