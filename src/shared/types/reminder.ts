/**
 * 提醒（久坐 / 喝水 / 未来的番茄钟、待办截止）的共享类型。
 *
 * 这里刻意把「提醒的类型」和「提醒的运行状态」分开：
 * - `ReminderKind` 是投递层（notifier）与各调度器之间的契约；
 * - `ReminderStatus` 只服务于设置页展示，是只读快照。
 */

export type ReminderKind = 'sedentary' | 'water' | 'pomodoro' | 'todo'

/** 最近一次真正投递出去的提醒 */
export interface DeliveredReminder {
  kind: ReminderKind
  /** 系统通知标题 */
  title: string
  /** 系统通知正文 */
  body: string
  /**
   * 宠物实际说出的那一句（读的是气泡表，可能被 pet manifest 覆盖，
   * 也可能因为宠物被用户藏起来而没说出来 → null）
   */
  bubble: string | null
  at: number
}

export interface SedentaryStatus {
  enabled: boolean
  /** 是否判定为「人在电脑前」 */
  present: boolean
  /** 当前系统空闲秒数（powerMonitor.getSystemIdleTime()） */
  idleSec: number
  /** 当前连续活跃段已累计的毫秒数；0 = 尚未开始或已判定离开 */
  activeMs: number
  /** 到点提醒的阈值（毫秒） */
  remindMs: number
  /** 离开座位的空闲判定阈值（秒） */
  awaySec: number
}

export interface WaterStatus {
  enabled: boolean
  /** 下一次提醒的绝对时间戳；0 = 未排程 */
  nextAt: number
  intervalMs: number
}

export interface ReminderStatus {
  sedentary: SedentaryStatus
  water: WaterStatus
  /** 是否处于免打扰 */
  dnd: boolean
  /** 免打扰结束的绝对时间戳；0 = 未开启 */
  dndUntil: number
  last: DeliveredReminder | null
}
