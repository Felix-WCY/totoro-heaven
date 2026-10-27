/**
 * 地图中心定位纯函数自测（`utils/mp/mapCenter.ts`）
 *
 * 2026-10-27 真实故障回归：厂商下发的线路点坐标是**字符串**（`"32.032922"`），
 * 旧实现用 `Number.isFinite` 过滤 ⇒ 全部被丢掉 ⇒ 学校中心算不出来 ⇒ 地图停在"中性默认点"
 * （甘肃），用户反馈「这卫星图不对 / 这都不是我这地方」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  centerOfPoints,
  NEUTRAL_MAP_CENTER,
  parseManualLatLng,
  schoolCenter,
  schoolMapSpots,
  tryDesktopGeolocate,
  tryGeolocate,
} from '../../utils/mp/mapCenter.ts'

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

/**
 * 🆕 2026-10-27：手动坐标兜底（浏览器/系统定位不可用时，用户从高德/微信复制坐标粘进来）。
 * 现场：研途健行任务没有官方线路，系统定位又拿不到位置，地图只能停在甘肃，用户没法画。
 */
test('parseManualLatLng：纬度,经度（本页提示写法）', () => {
  const p = parseManualLatLng('31.3735,119.4808')
  assert.ok(p)
  assert.ok(Math.abs(p!.latitude - 31.3735) < 1e-9)
  assert.ok(Math.abs(p!.longitude - 119.4808) < 1e-9)
})

test('parseManualLatLng：高德复制常见的经度,纬度 —— 自动交换', () => {
  const p = parseManualLatLng('119.4808,31.3735')
  assert.ok(p)
  assert.ok(Math.abs(p!.latitude - 31.3735) < 1e-9)
  assert.ok(Math.abs(p!.longitude - 119.4808) < 1e-9)
})

test('parseManualLatLng：空格/中文逗号/分号分隔都认', () => {
  for (const text of ['31.3735 119.4808', '31.3735，119.4808', '31.3735;119.4808', '  31.3735, 119.4808  ']) {
    const p = parseManualLatLng(text)
    assert.ok(p, `应能解析：${text}`)
    assert.ok(Math.abs(p!.latitude - 31.3735) < 1e-9, text)
    assert.ok(Math.abs(p!.longitude - 119.4808) < 1e-9, text)
  }
})

test('parseManualLatLng：缺一个数/非数字/越界 一律返回 null（不把坏数据当地址）', () => {
  for (const text of ['', '31.3735', 'abc', '31.3735,abc', '31.3735,119.4808,1', '91,181', '200,300']) {
    assert.equal(parseManualLatLng(text), null, `必须拒绝：${text}`)
  }
})

/**
 * 🆕 2026-10-27（用户实测：浏览器版定位正常、桌面版不可用）：
 * 桌面端由 Electron 主进程调 Windows WinRT 定位，经 preload 暴露 `window.totoroDesktop.locate()`。
 * 页面侧必须优先用它（桌面端 navigator.geolocation 经常不可用）。
 */
test('tryDesktopGeolocate：桌面桥可用时返回主进程坐标（含精度）', async () => {
  ;(globalThis as unknown as { window?: unknown }).window = {
    totoroDesktop: {
      locate: async () => ({ ok: true, latitude: 31.2846, longitude: 121.4962, accuracy: 90 }),
    },
  }
  try {
    const fix = await tryDesktopGeolocate()
    assert.ok(fix)
    assert.ok(Math.abs(fix!.latitude - 31.2846) < 1e-9)
    assert.ok(Math.abs(fix!.longitude - 121.4962) < 1e-9)
    assert.equal(fix!.accuracyM, 90)
  } finally {
    delete (globalThis as unknown as { window?: unknown }).window
  }
})

test('tryGeolocate：有桌面桥时优先走桌面定位（不需要 navigator）', async () => {
  ;(globalThis as unknown as { window?: unknown }).window = {
    totoroDesktop: {
      locate: async () => ({ ok: true, latitude: 32.1, longitude: 118.7, accuracy: 0 }),
    },
  }
  try {
    // 注意：Node 里 navigator.geolocation 不存在；如果没优先走桌面桥就会返回 null
    const fix = await tryGeolocate()
    assert.ok(fix, '有桌面桥时必须返回桌面坐标')
    assert.ok(Math.abs(fix!.latitude - 32.1) < 1e-9)
    assert.ok(Math.abs(fix!.longitude - 118.7) < 1e-9)
  } finally {
    delete (globalThis as unknown as { window?: unknown }).window
  }
})

test('tryDesktopGeolocate：桥不存在 / 系统拒绝 / 返回坏坐标 ⇒ null（不抛错）', async () => {
  delete (globalThis as unknown as { window?: unknown }).window
  assert.equal(await tryDesktopGeolocate(), null, '网页端没有桥 ⇒ null')

  ;(globalThis as unknown as { window?: unknown }).window = {
    totoroDesktop: { locate: async () => ({ ok: false, error: 'denied' }) },
  }
  try {
    assert.equal(await tryDesktopGeolocate(), null, '系统拒绝 ⇒ null')
  } finally {
    delete (globalThis as unknown as { window?: unknown }).window
  }

  ;(globalThis as unknown as { window?: unknown }).window = {
    totoroDesktop: { locate: async () => ({ ok: true, latitude: 'bad', longitude: 121 }) },
  }
  try {
    assert.equal(await tryDesktopGeolocate(), null, '坏坐标 ⇒ null')
  } finally {
    delete (globalThis as unknown as { window?: unknown }).window
  }
})
