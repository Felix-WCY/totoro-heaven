/**
 * **时钟回拨检测**（纯函数，可离线单测）
 *
 * ## 要解决的问题
 * 离线授权的到期判断用的是**买家电脑的本地时钟**（`Date.now()`）。
 * 没有可信时间源，买家只要把系统时间调回购买那天，证书就**永远不过期**。
 *
 * ## 做法（两层）
 * 1. **记录历史最大时间**：每次运行把「见过的最晚时间」落盘（只增不减）；
 * 2. **判定有效期时用累计时间** `max(当前时钟, 历史最大)`：
 *    买家把时钟调回去，累计时间也不会倒退 —— 到期照常触发；
 *    并且当前时钟**早于历史最大值超过容差**时，直接判定为「时间被回拨」（fail closed）。
 *
 * ## 容差为什么是 24 小时
 * - 买家可能只是**修正了错乱的时钟**（系统时间漂了、换时区设置），这不该当成作弊；
 * - 24 小时与证书本身的 `LICENSE_CLOCK_SKEW_S` 同量级，口径一致；
 * - 真要作弊必须**往回退至少一天**，而这期间累计时间已经在前进，白忙。
 *
 * ## 边界（如实说明，不粉饰）
 * - 删掉状态文件即可重置。**但状态文件与 `license.json` 同目录**，
 *   删了就等于授权一起丢，得重新激活；而卡密在服务端已置为「已用」，激活不回来。
 * - 想彻底防住，只能靠**在线校验**（每次启动问服务器当前时间/授权状态）。
 *   这是离线模型的固有上限，不是本模块的缺陷。
 */

/** 允许的时钟回拨容差：24 小时（与证书的时钟偏差容差同量级） */
export const CLOCK_ROLLBACK_TOLERANCE_MS = 24 * 60 * 60 * 1000

/** 状态文件的更新间隔：超过它才落盘，避免每次查状态都写盘 */
export const CLOCK_STATE_MIN_STEP_MS = 60 * 1000

export interface ClockCheckInput {
  /** 当前本地时钟（毫秒） */
  nowMs: number
  /** 历史见过的最大时间（毫秒；`0` 表示还没有记录） */
  lastSeenMs: number
  /** 回拨容差，默认 24 小时 */
  toleranceMs?: number
}

export interface ClockCheckResult {
  /** 是否允许继续（`false` = 判定为时间回拨，应拒用） */
  ok: boolean
  /** 是否判定为回拨 */
  rolledBack: boolean
  /** **判定有效期时该用的时间**：`max(当前, 历史最大)` */
  effectiveNowMs: number
  /** 回拨了多少毫秒（未回拨为 `0`） */
  rollbackMs: number
  /** 是否应该把 `effectiveNowMs` 写回状态文件（只增不减，且有最小步长） */
  shouldPersist: boolean
}

/**
 * 判定时钟是否被回拨，并给出"该用哪个时间"。
 *
 * 纯函数：不读盘、不取系统时间 —— 单测可以直接喂任意数值。
 */
export function checkClock(input: ClockCheckInput): ClockCheckResult {
  const toleranceMs =
    Number.isFinite(input.toleranceMs) && (input.toleranceMs as number) >= 0
      ? (input.toleranceMs as number)
      : CLOCK_ROLLBACK_TOLERANCE_MS

  const now = Math.floor(Number.isFinite(input.nowMs) ? input.nowMs : 0)
  const last = Math.max(0, Math.floor(Number.isFinite(input.lastSeenMs) ? input.lastSeenMs : 0))

  // 累计时间只增不减：时钟往回退，也不让"已用时间"倒退
  const effectiveNowMs = Math.max(now, last)

  // 只有"历史最大时间"存在且当前时钟更早，才算回拨
  const rollbackMs = last > 0 && now < last ? last - now : 0
  const rolledBack = rollbackMs > toleranceMs

  // 只在不回拨时推进状态；且要超过最小步长才值得写盘
  const shouldPersist = !rolledBack && effectiveNowMs - last >= CLOCK_STATE_MIN_STEP_MS

  return { ok: !rolledBack, rolledBack, effectiveNowMs, rollbackMs, shouldPersist }
}

/** 把回拨时长说成人话（日志/提示用） */
export function describeRollback(rollbackMs: number): string {
  if (!Number.isFinite(rollbackMs) || rollbackMs <= 0) return '无回拨'
  const hours = Math.floor(rollbackMs / 3600000)
  if (hours < 24) return `约 ${hours} 小时`
  const days = Math.floor(hours / 24)
  return `约 ${days} 天`
}
