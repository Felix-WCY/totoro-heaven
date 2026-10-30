/**
 * 地图中心定位（跑道编辑 / 自由路线绘制共用）。
 *
 * ## 为什么独立成一个模块（2026-10-27 实际故障）
 * 两个地图组件的初始中心原本**写死成南航天目湖校区**（`31.3735, 119.4808`）：
 *
 * ```ts
 * const center = ref<N>({ latitude: 31.3735, longitude: 119.4808 }) // 默认：天目湖校区
 * ```
 *
 * 后果：其他学校（如辽宁科技大学，在鞍山）打开「我的场地 → 跑道编辑」时，
 * 地图停在**南航的操场**上 —— 用户找不到自己的操场，自然"画不了跑道"，也就跑不了。
 *
 * ## 现在的取值顺序
 *   ① 已选线路 / 本任务官方线路的坐标包围盒中心（调用方已有的 `focusOn()` 逻辑）
 *   ② **使用者当前位置**（浏览器定位，本模块负责）—— 对任何学校都成立，不需要学校坐标表
 *   ③ 中性默认值（中国地理中心附近），仅当用户拒绝/超时才用
 */

/** 中性默认中心（中国地理中心附近，约甘肃天水）。仅在拿不到任何位置信息时使用。 */
export const NEUTRAL_MAP_CENTER = { latitude: 34.5809, longitude: 105.7249 } as const

export interface LatLngLike {
  latitude: number
  longitude: number
}

/** 契约层坐标：厂商下发的点列里 latitude/longitude **可能是字符串**（实测 `"32.032922"`） */
export interface LatLngInput {
  latitude: number | string
  longitude: number | string
}

/** 把一个坐标分量收敛成有限数字；空串/非数字/NaN 一律返回 null（不猜） */
function finiteCoord(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return null
    const n = Number(text)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * 一组点的包围盒中心（点不足 2 个返回 null）。
 *
 * ⚠️ **必须接受字符串坐标**（2026-10-27 真实故障）：厂商接口下发的是 `"32.032922"` 这种字符串，
 * 原实现用 `Number.isFinite(p.latitude)` 过滤 ⇒ 字符串全部被丢掉 ⇒ `schoolCenter()` 返回 null ⇒
 * 「跑道编辑」打开时退回浏览器定位；桌面端/定位失败时地图停在甘肃的中性默认点，
 * 用户看到的就是「这卫星图不对 / 这都不是我这地方」。
 */
export function centerOfPoints(points: readonly LatLngInput[] | null | undefined): LatLngLike | null {
  const pts: LatLngLike[] = []
  for (const p of points ?? []) {
    if (!p) continue
    const latitude = finiteCoord(p.latitude)
    const longitude = finiteCoord(p.longitude)
    if (latitude === null || longitude === null) continue
    pts.push({ latitude, longitude })
  }
  if (pts.length < 2) return null
  const lats = pts.map((p) => p.latitude)
  const lngs = pts.map((p) => p.longitude)
  return {
    latitude: (Math.min(...lats) + Math.max(...lats)) / 2,
    longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2,
  }
}

/** 地图上可跳转的"地点"（= 该校的一条官方线路 / 一个操场） */
export interface MapSpot {
  /** 地点名（线路名，如「主操场跑步线路」） */
  name: string
  /** 该地点的几何中心 */
  center: LatLngLike
}

/**
 * 从**本任务的官方线路**里提取"这所学校有哪些场地"。
 *
 * 用户口径（2026-10-27）：「不要根据已选线路，要根据学校来 —— 同一个学校的可以选择」。
 * 也就是说：地图先落在**学校**的范围（所有线路），再由用户在同一所学校的多个操场之间选。
 *
 * @param lines 本任务的 `runPointList`（每个含 `pointName` 与点列）
 * @returns 有坐标的场地列表（顺序与下发一致；没有坐标的线路会被跳过）
 */
export function schoolMapSpots(
  lines: readonly { pointName?: unknown; pointList?: readonly LatLngInput[] }[] | null | undefined,
): MapSpot[] {
  const out: MapSpot[] = []
  for (const [i, line] of (lines ?? []).entries()) {
    const c = centerOfPoints(line?.pointList)
    if (!c) continue
    const name = String(line?.pointName ?? '').trim() || `第 ${i + 1} 条线路`
    out.push({ name, center: c })
  }
  return out
}

/**
 * 整所学校的范围中心（= 该校**所有**线路点列合在一起的包围盒中心）。
 * 用于"打开就先落在学校"——而不是落在某一条被选中的线路上。
 */
export function schoolCenter(
  lines: readonly { pointList?: readonly LatLngInput[] }[] | null | undefined,
): LatLngLike | null {
  const all: LatLngInput[] = []
  for (const line of lines ?? []) all.push(...((line?.pointList ?? []) as LatLngInput[]))
  return centerOfPoints(all)
}

/**
 * 🆕 2026-10-30（江苏科技大学真实诊断包）：**多校区**任务的初始中心。
 *
 * 江苏「长山校区课外跑任务」同时下发 4 条线路：长山校区 2 条（119.36, 32.10 附近）、
 * 梦溪校区 1 条（镇江市区，离长山十几公里），还有一条 `9999`。
 * 若沿用「全校所有线路的包围盒中心」（`schoolCenter`），地图会落在两个校区中间的空地，
 * 用户看到的又是「这卫星图不对 / 这不是我这地方」。
 *
 * 取值顺序：
 *   ① **当前校区**的线路（线路名包含 `campusName`，如「长山校区体育馆操场路线」）；
 *   ② 否则用当前选中线路（只有它确实属于本任务线路时才用，避免旧缓存串校）；
 *   ③ 最后才退回全校所有线路的包围盒中心。
 */
export function campusCenter(
  lines: readonly { pointId?: unknown; pointName?: unknown; pointList?: readonly LatLngInput[] }[] | null | undefined,
  campusName?: string | null,
  selectedLineId?: string | null,
): LatLngLike | null {
  const list = lines ?? []
  const campus = String(campusName ?? '').trim()
  if (campus) {
    const campusPts: LatLngInput[] = []
    for (const line of list) {
      if (!String(line?.pointName ?? '').includes(campus)) continue
      for (const p of line?.pointList ?? []) campusPts.push(p)
    }
    const byCampus = centerOfPoints(campusPts)
    if (byCampus) return byCampus
  }
  const selectedId = String(selectedLineId ?? '').trim()
  if (selectedId) {
    const selected = list.find((line) => String(line?.pointId ?? '') === selectedId)
    const bySelected = centerOfPoints(selected?.pointList)
    if (bySelected) return bySelected
  }
  return schoolCenter(list)
}

/**
 * 手动解析用户粘贴的坐标（浏览器定位不可用时的兜底）。
 *
 * 支持：
 *   · `31.3735,119.4808`（纬度,经度 —— 本页面提示的写法）
 *   · `119.4808,31.3735`（高德/微信“复制坐标”常见的经度,纬度 —— 自动识别并交换）
 *   · 逗号/中文逗号/分号/空格 分隔都可以
 *
 * 判据（简单且可解释）：`|值| > 90` 的那个一定是经度；两个都 ≤ 90 时按“纬度,经度”解释。
 * 解析失败返回 null（不猜、不把坏数据当地址）。
 */
export function parseManualLatLng(text: string): LatLngLike | null {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const nums = raw.match(/-?\d+(?:\.\d+)?/g)
  if (!nums || nums.length !== 2) return null
  const a = Number(nums[0])
  const b = Number(nums[1])
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  let latitude: number
  let longitude: number
  if (Math.abs(a) > 90 && Math.abs(b) <= 90) {
    longitude = a
    latitude = b
  } else if (Math.abs(b) > 90 && Math.abs(a) <= 90) {
    latitude = a
    longitude = b
  } else if (Math.abs(a) <= 90 && Math.abs(b) <= 90) {
    // 两个都像纬度时按用户提示的“纬度,经度”解释（中国大部分地区经度 > 90，会走上面两支）
    latitude = a
    longitude = b
  } else {
    return null
  }
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  return { latitude, longitude }
}

/** 桌面端（Electron）主进程回传的定位结果 */
export interface DesktopGeoFix {
  latitude: number
  longitude: number
  accuracyM: number
}

interface DesktopGeoBridge {
  locate(): Promise<{ ok?: boolean; latitude?: number; longitude?: number; accuracy?: number; error?: string }>
}

/** 桌面端 preload 暴露的桥（`electron/preload.cjs` → `window.totoroDesktop`）；网页端没有 */
function desktopGeoBridge(): DesktopGeoBridge | undefined {
  if (typeof window === 'undefined') return undefined
  const bridge = (window as unknown as { totoroDesktop?: DesktopGeoBridge }).totoroDesktop
  return bridge && typeof bridge.locate === 'function' ? bridge : undefined
}

/**
 * 桌面端定位：由 Electron 主进程调 **Windows 定位服务（WinRT）**再回传。
 *
 * 为什么要它：Electron 自带的 Chromium 在 Windows/国内环境下经常拿不到位置
 * （没有 Google 定位服务；老的 `WinrtGeolocationImplementation` 开关在当前 Chromium 里已不生效），
 * 而浏览器版用的是浏览器自己的定位服务所以正常。网页端没有这个桥 ⇒ 返回 null，走 navigator。
 */
export async function tryDesktopGeolocate(): Promise<DesktopGeoFix | null> {
  const bridge = desktopGeoBridge()
  if (!bridge) return null
  try {
    const result = await bridge.locate()
    if (!result || result.ok !== true) return null
    const latitude = Number(result.latitude)
    const longitude = Number(result.longitude)
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
    const accuracyM = Number(result.accuracy)
    return { latitude, longitude, accuracyM: Number.isFinite(accuracyM) && accuracyM > 0 ? accuracyM : 0 }
  } catch {
    return null
  }
}

/**
 * 取使用者当前位置（浏览器定位 / 桌面端系统定位）。
 * **绝不抛错**：不支持 / 被拒 / 超时一律返回 `null`，调用方继续用中性默认值。
 *
 * 顺序：Electron 里优先走主进程 Windows 定位（桌面端 navigator 经常不可用）；
 *       网页端没有桥，直接走浏览器定位。
 *
 * @param timeoutMs 超时（毫秒）。默认 6 秒 —— 用户对着"要不要允许定位"的弹窗犹豫时，
 *                  不能让地图一直不出现。
 */
export async function tryGeolocate(timeoutMs = 6000): Promise<LatLngLike | null> {
  const desktopFix = await tryDesktopGeolocate()
  if (desktopFix) return desktopFix
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    const finish = (v: LatLngLike | null) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), timeoutMs + 500)
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          clearTimeout(timer)
          finish({ latitude: pos.coords.latitude, longitude: pos.coords.longitude })
        },
        () => {
          clearTimeout(timer)
          finish(null)
        },
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
      )
    } catch {
      clearTimeout(timer)
      finish(null)
    }
  })
}
