/**
 * 地图中心定位纯函数自测（`utils/mp/mapCenter.ts`）
 *
 * 2026-10-27 真实故障回归：厂商下发的线路点坐标是**字符串**（`"32.032922"`），
 * 旧实现用 `Number.isFinite` 过滤 ⇒ 全部被丢掉 ⇒ 学校中心算不出来 ⇒ 地图停在"中性默认点"
 * （甘肃），用户反馈「这卫星图不对 / 这都不是我这地方」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { centerOfPoints, NEUTRAL_MAP_CENTER, schoolCenter, schoolMapSpots } from '../../utils/mp/mapCenter.ts'

const num = (v: string | number) => Number(v)

test('centerOfPoints：字符串坐标必须被识别（不能因为不是 number 就丢掉）', () => {
  const center = centerOfPoints([
    { latitude: '32.000000', longitude: '118.000000' },
    { latitude: '32.010000', longitude: '118.010000' },
  ])
  assert.ok(center, '两点字符串坐标必须算出中心，不能返回 null')
  assert.ok(Math.abs(center!.latitude - num('32.005000')) < 1e-9, '纬度中心')
  assert.ok(Math.abs(center!.longitude - num('118.005000')) < 1e-9, '经度中心')
})

test('centerOfPoints：数字与字符串混合也按同一口径算', () => {
  const center = centerOfPoints([
    { latitude: 31, longitude: 119 },
    { latitude: '31.02', longitude: '119.02' },
  ])
  assert.ok(center)
  assert.ok(Math.abs(center!.latitude - 31.01) < 1e-9)
  assert.ok(Math.abs(center!.longitude - 119.01) < 1e-9)
})

test('centerOfPoints：少于 2 个有效点返回 null（不瞎猜）', () => {
  assert.equal(centerOfPoints(null), null)
  assert.equal(centerOfPoints([]), null)
  assert.equal(centerOfPoints([{ latitude: 30, longitude: 120 }]), null)
})

test('centerOfPoints：坏坐标（空串/非数字/NaN/Infinity）被过滤，绝不产 NaN', () => {
  const center = centerOfPoints([
    { latitude: '', longitude: '' },
    { latitude: 'abc', longitude: '119' },
    { latitude: Number.NaN, longitude: 119 },
    { latitude: Number.POSITIVE_INFINITY, longitude: 119 },
    { latitude: '30.5', longitude: '120.5' },
    { latitude: '30.7', longitude: '120.7' },
  ] as never)
  assert.ok(center)
  assert.ok(Math.abs(center!.latitude - 30.6) < 1e-9)
  assert.ok(Math.abs(center!.longitude - 120.6) < 1e-9)
})

test('schoolCenter：把一所学校**所有线路**的点算成一个包围盒中心（字符串坐标同样有效）', () => {
  const lines = [
    {
      pointList: [
        { latitude: '32.0', longitude: '118.0' },
        { latitude: '32.0', longitude: '118.02' },
      ],
    },
    {
      pointList: [
        { latitude: '32.02', longitude: '118.0' },
        { latitude: '32.02', longitude: '118.02' },
      ],
    },
  ]
  const center = schoolCenter(lines)
  assert.ok(center)
  assert.ok(Math.abs(center!.latitude - 32.01) < 1e-9)
  assert.ok(Math.abs(center!.longitude - 118.01) < 1e-9)
})

test('schoolMapSpots：每条有坐标的线路给出一个场地中心；没坐标的被跳过', () => {
  const spots = schoolMapSpots([
    { pointName: '主操场', pointList: [{ latitude: '32', longitude: '118' }, { latitude: '32.001', longitude: '118.001' }] },
    { pointName: '没有坐标', pointList: [] },
    { pointName: '', pointList: [{ latitude: '32.1', longitude: '118.1' }, { latitude: '32.101', longitude: '118.101' }] },
  ])
  assert.equal(spots.length, 2)
  assert.equal(spots[0]!.name, '主操场')
  assert.equal(spots[1]!.name, '第 3 条线路', '没有名字时用序号兜底')
})

test('中性默认值保持"中国地理中心附近"，不能被学校/用户位置悄悄污染', () => {
  assert.ok(NEUTRAL_MAP_CENTER.latitude > 30 && NEUTRAL_MAP_CENTER.latitude < 40)
  assert.ok(NEUTRAL_MAP_CENTER.longitude > 100 && NEUTRAL_MAP_CENTER.longitude < 110)
})
