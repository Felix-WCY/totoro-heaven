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

/** 一组点的包围盒中心（点不足 2 个返回 null） */
export function centerOfPoints(points: readonly LatLngLike[] | null | undefined): LatLngLike | null {
  const pts = (points ?? []).filter(
    (p) => p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude),
  )
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
  lines: readonly { pointName?: unknown; pointList?: readonly LatLngLike[] }[] | null | undefined,
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
  lines: readonly { pointList?: readonly LatLngLike[] }[] | null | undefined,
): LatLngLike | null {
  const all: LatLngLike[] = []
  for (const line of lines ?? []) all.push(...((line?.pointList ?? []) as LatLngLike[]))
  return centerOfPoints(all)
}

/**
 * 取使用者当前位置（浏览器定位）。
 * **绝不抛错**：不支持 / 被拒 / 超时一律返回 `null`，调用方继续用中性默认值。
 *
 * @param timeoutMs 超时（毫秒）。默认 6 秒 —— 用户对着"要不要允许定位"的弹窗犹豫时，
 *                  不能让地图一直不出现。
 */
export function tryGeolocate(timeoutMs = 6000): Promise<LatLngLike | null> {
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
