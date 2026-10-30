/**
 * **按学校智能识别「单次目标里程」**（用户 2026-10-27 口径：南航那套系统自动设好、不用手动调，
 * 别的学校也必须自动识别，不能让用户自己去填）。
 *
 * ## 为什么需要它
 * 各校的阳光跑任务**不是同一个标准**：
 *   · 南航：3.20 km / 拟合度 0.60 / 3~15 km/h / 10~25 分钟
 *   · 辽宁科技大学：**1.5 km**（每学期 70 次）
 *
 * 正常情况下"任务下发"的 `getSunrunArch.mileage` 就带着这个值，直接用它即可。
 * 但实测存在**任务没下发里程**（字段缺失 / 0）的情况 —— 那时旧代码会回落到一个
 * 通用兜底值，跑出来明显不是该校的要求，用户只能手动改，体验与"南航自动"不一致。
 *
 * ## 判定顺序（唯一入口）
 *   ① 任务下发的 `mileage` > 0 → 用任务的（**永远是第一优先**，学校变更配置时自动跟随）
 *   ② 否则查本文件的**学校档案表** → 用该校典型里程
 *   ③ 都没有 → 返回 0（交给调用方决定兜底，不在这里瞎猜）
 *
 * ⚠️ 档案表只在②生效：**不要**把它当成硬编码覆盖。任务给了值就以任务为准。
 */

/** 一所学校的任务默认参数 */
export interface SchoolTaskProfile {
  /** 学校代码（= `GetStudentInfoByToken` 的 schoolCode） */
  schoolCode: string
  schoolName: string
  /** 单次目标里程（公里） */
  defaultMileageKm: number
  /** 依据（谁在什么时候给的 / 实测到的） */
  note: string
}

/**
 * 学校任务档案表。
 * ⚠️ 新增学校前先确认"任务确实没下发 mileage"——否则这张表就是没用的重复信息。
 */
export const SCHOOL_TASK_PROFILES: readonly SchoolTaskProfile[] = [
  {
    schoolCode: '98765',
    schoolName: '南京航空航天大学',
    defaultMileageKm: 3.2,
    note: '实测任务下发 3.20km（本表仅作任务缺失时的兜底）',
  },
  {
    schoolCode: 'uosatln',
    schoolName: '辽宁科技大学',
    defaultMileageKm: 1.5,
    note: '用户 2026-10-27 提供：单次 1.5 公里，每学期 70 次',
  },
  {
    schoolCode: '10289',
    schoolName: '江苏科技大学',
    defaultMileageKm: 1.2,
    note: '2026-10-30 真实诊断包：长山校区课外跑任务下发 1.20km（本表仅作任务缺失时的兜底）',
  },
]

/** 里程的来源（用于界面/日志说明"这个数是谁定的"） */
export type MileageSource = 'task' | 'school' | 'none'

export interface ResolvedMileage {
  km: number
  source: MileageSource
  /** 来源是学校档案时的校名（否则空串） */
  schoolName: string
}

/**
 * 解析本次该跑多少公里。
 * @param input.taskMileage 任务下发的 `mileage`（可能是数字/字符串/缺失/0）
 * @param input.schoolCode  当前登录学生的学校代码
 */
export function resolveSchoolMileage(input: { taskMileage?: unknown; schoolCode?: string | null }): ResolvedMileage {
  const fromTask = Number(input.taskMileage)
  if (Number.isFinite(fromTask) && fromTask > 0) return { km: fromTask, source: 'task', schoolName: '' }

  const code = String(input.schoolCode ?? '').trim()
  const hit = code ? SCHOOL_TASK_PROFILES.find((p) => p.schoolCode === code) : undefined
  if (hit) return { km: hit.defaultMileageKm, source: 'school', schoolName: hit.schoolName }

  return { km: 0, source: 'none', schoolName: '' }
}

/**
 * 任务**没下发里程**时，按学校补齐 `mileage`。
 * 命中学校档案 ⇒ 返回**新对象**（不改入参）；否则原样返回（同一引用，调用方可据此判断"没变"）。
 */
export function withSchoolDefaultMileage<T extends { mileage?: unknown }>(
  task: T,
  schoolCode?: string | null,
): T {
  const r = resolveSchoolMileage({ taskMileage: task?.mileage, schoolCode })
  if (r.source !== 'school') return task
  return { ...task, mileage: r.km }
}
