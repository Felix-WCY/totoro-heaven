/**
 * 「按学校智能识别单次目标里程」的测试。
 *
 * 现实背景（用户 2026-10-27）：南航是 3.20 km、辽宁科技大学是 **1.5 km**，
 * 用户要求"系统自动识别，不要手动调"。判定顺序必须是：
 *   ① 任务下发的 mileage > 0（第一优先，学校改配置能自动跟随）
 *   ② 否则按 schoolCode 查学校档案
 *   ③ 都没有 → 0（调用方自行兜底，不瞎猜）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SCHOOL_TASK_PROFILES,
  resolveSchoolMileage,
  withSchoolDefaultMileage,
} from '../../utils/mp/schoolTaskProfile'

test('任务下发里程优先：任务给了就用任务的，不看学校档案', () => {
  // 辽宁科技大学档案是 1.5，但任务若下发 2.4，必须以任务为准（学校改了配置要跟随）
  const r = resolveSchoolMileage({ taskMileage: 2.4, schoolCode: 'uosatln' })
  assert.equal(r.km, 2.4)
  assert.equal(r.source, 'task')
  assert.equal(r.schoolName, '')
})

test('任务未下发里程 → 按学校补齐（辽宁科技大学 1.5 / 南航 3.2）', () => {
  for (const bad of [undefined, null, '', 0, '0', 'abc', NaN]) {
    const lk = resolveSchoolMileage({ taskMileage: bad, schoolCode: 'uosatln' })
    assert.equal(lk.km, 1.5, `辽宁科技大学对 ${String(bad)} 应回落 1.5`)
    assert.equal(lk.source, 'school')

    const nu = resolveSchoolMileage({ taskMileage: bad, schoolCode: '98765' })
    assert.equal(nu.km, 3.2, `南航对 ${String(bad)} 应回落 3.2`)
    assert.equal(nu.source, 'school')
  }
})

test('字符串数字也当有效任务里程', () => {
  const r = resolveSchoolMileage({ taskMileage: '1.5', schoolCode: '98765' })
  assert.equal(r.km, 1.5)
  assert.equal(r.source, 'task')
})

test('未登记的学校 → 不猜，返回 0 且 source=none', () => {
  const r = resolveSchoolMileage({ taskMileage: undefined, schoolCode: 'nku' })
  assert.equal(r.km, 0)
  assert.equal(r.source, 'none')
})

test('withSchoolDefaultMileage：命中学校返回新对象并补上 mileage；未命中返回原引用', () => {
  const t = { taskId: 'T1', paperName: '阳光跑' } as { taskId: string; paperName: string; mileage?: unknown }
  const patched = withSchoolDefaultMileage(t, 'uosatln')
  assert.notEqual(patched, t, '命中学校时应返回新对象')
  assert.equal(patched.mileage, 1.5)
  assert.equal(t.mileage, undefined, '不得改动入参')

  const untouched = withSchoolDefaultMileage(t, 'nku')
  assert.equal(untouched, t, '未命中学校时应返回原引用')

  const already = { taskId: 'T2', mileage: 2.4 }
  assert.equal(withSchoolDefaultMileage(already, 'uosatln'), already, '任务已有里程时不该改')
})

test('档案表自身约束：学校码唯一、里程为正', () => {
  const codes = SCHOOL_TASK_PROFILES.map((p) => p.schoolCode)
  assert.equal(new Set(codes).size, codes.length, 'schoolCode 不得重复')
  for (const p of SCHOOL_TASK_PROFILES) {
    assert.ok(p.defaultMileageKm > 0, `${p.schoolName} 的默认里程必须为正`)
    assert.ok(p.note.length > 0, `${p.schoolName} 必须写明依据`)
  }
  // 本次实测涉及的两所必须在表内
  assert.ok(codes.includes('98765'))
  assert.ok(codes.includes('uosatln'))
})
