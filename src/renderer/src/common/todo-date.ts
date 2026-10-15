/**
 * 待办的时间展示工具（渲染层共用：设置页 + 旁挂小面板）。
 *
 * 为什么单独放一份而不是各写各的：两个窗口必须对"已过期"给出**同一个判断**。
 * 差一小时、差一天这种不一致，用户第一眼就会看出来（"设置页说今天到期，面板说已过期"）。
 *
 * 全部按**本地时区**处理：截止时间是用户脑子里的"今天 18:00"，不是 UTC。
 */

/** 本地日的 00:00:00.000 */
export function startOfLocalDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 本地日的 23:59:59.999 */
export function endOfLocalDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(23, 59, 59, 999)
  return d.getTime()
}

export function isOverdue(dueAt: number | null, now = Date.now()): boolean {
  return dueAt !== null && dueAt < now
}

/** 截止时间是否落在"今天"（本地日），已过期的也算今天口径之外 —— 过期单独有一套展示 */
export function isToday(dueAt: number | null, now = Date.now()): boolean {
  if (dueAt === null) return false
  return dueAt >= startOfLocalDay(now) && dueAt <= endOfLocalDay(now)
}

/** 分组：面板按这个排序（过期 → 今天 → 以后 → 没截止） */
export type DueBucket = 'overdue' | 'today' | 'later' | 'none'

export function dueBucket(dueAt: number | null, now = Date.now()): DueBucket {
  if (dueAt === null) return 'none'
  if (dueAt < now) return 'overdue'
  if (isToday(dueAt, now)) return 'today'
  return 'later'
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function hhmm(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 完整日期时间，用于 tooltip 与编辑弹框的只读展示 */
export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm(ts)}`
}

/** 已过期多久：'已过期 3 天' / '已过期 5 小时' / '已过期 12 分钟' */
export function formatOverdueSpan(dueAt: number, now = Date.now()): string {
  const diff = Math.max(0, now - dueAt)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `已过期 ${Math.max(1, minutes)} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `已过期 ${hours} 小时`
  return `已过期 ${Math.floor(hours / 24)} 天`
}

/**
 * 列表里显示的截止时间短文案。
 * 已过期的返回空串 —— 过期状态由专门的红色角标（`formatOverdueSpan`）表达，
 * 两处都写会让列表行变得又长又吵。
 */
export function formatDueShort(dueAt: number | null, now = Date.now()): string {
  if (dueAt === null) return ''
  if (dueAt < now) return ''
  const day = startOfLocalDay(dueAt)
  const today = startOfLocalDay(now)
  const diffDays = Math.round((day - today) / 86_400_000)
  if (diffDays === 0) return `今天 ${hhmm(dueAt)}`
  if (diffDays === 1) return `明天 ${hhmm(dueAt)}`
  const d = new Date(dueAt)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return sameYear ? `${md} ${hhmm(dueAt)}` : `${d.getFullYear()}-${md} ${hhmm(dueAt)}`
}
