import { powerMonitor } from 'electron'
import {
  REMIND_FAST_AWAY_SEC,
  REMIND_FAST_SEDENTARY_SEC,
  REMIND_FAST_WATER_SEC,
  REMINDER_TICK_MS,
  WATER_PRESENCE_IDLE_SEC
} from '../../shared/constants'
import type { ReminderStatus } from '../../shared/types/reminder'
import type { AppSettings } from '../../shared/types/settings'
import { createLogger } from '../utils/logger'
import { notifier } from './notifier'
import { getSettings } from './settingsService'

const log = createLogger('reminder')

/**
 * 久坐提醒 + 喝水提醒。
 *
 * ## 为什么两条时间都存「绝对时间戳」而不是累加计数器
 * `setInterval` 在系统休眠、CPU 满载、窗口失焦的情况下会漏拍或漂移，
 * 累加出来的"坐了多久"会越来越不准。这里只存两个时刻：
 * - `activeSince`：当前**连续活跃段**的起点。坐多久 = `now - activeSince`，永远精确。
 * - `nextWaterAt`：下一次喝水提醒的**绝对**时刻。到点即触发，不依赖 tick 的准点性
 *   （tick 只负责"来检查一下到点没有"，迟到了也不会累积误差）。
 *
 * ## 久坐的"离开判定"是这套逻辑的关键
 * 直接用墙上时间计时，开会 / 午休都会被算成久坐，提醒就变成了噪音。
 * 所以引入 `activeSince` 的中断条件：`powerMonitor.getSystemIdleTime()`
 * 超过 `sedentary.idleMinutes` 就判定用户离开，把连续活跃段清零。
 *
 * ⚠️ 这个判定的粒度就是那个阈值本身：用户离开后，要等 idle 涨到阈值我们才知道，
 * 所以离开前最多 `idleMinutes` 的那一段会被误算成活跃。3 分钟量级的误差放在
 * 45 分钟的尺度上无所谓，不值得为它引入"回填上次活动时刻"的复杂度。
 */
class ReminderScheduler {
  private timer: NodeJS.Timeout | null = null
  /** 当前连续活跃段的起点；0 = 尚未开始或已判定离开 */
  private activeSince = 0
  /** 下一次喝水提醒的绝对时间戳；0 = 未排程 */
  private nextWaterAt = 0
  /** 上次使用的喝水间隔，用来判断"设置里改了间隔" */
  private lastWaterMs = 0
  /** 开发期加速（见 REMIND_FAST_* 常量的注释） */
  private readonly fast = !!process.env['HPY_FAST_REMIND']

  start(): void {
    if (this.timer) return
    if (this.fast) {
      log.warn('开发期加速已开启（HPY_FAST_REMIND）：提醒阈值被压到秒级，不是真实时长')
    }
    this.timer = setInterval(() => this.tick(), REMINDER_TICK_MS)
    // 立刻评估一次，这样设置页刚打开时的读数不是空的
    this.tick()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.activeSince = 0
    this.nextWaterAt = 0
  }

  /** 设置变化后调用 */
  refresh(): void {
    const settings = getSettings()
    const waterMs = this.waterIntervalMs(settings)
    // 只在间隔真的改了才重排，否则任何一次设置写入（比如切一下免打扰）
    // 都会把喝水倒计时重置，用户会觉得"怎么永远不到点"
    if (this.nextWaterAt !== 0 && waterMs !== this.lastWaterMs) {
      this.nextWaterAt = Date.now() + waterMs
    }
    this.lastWaterMs = waterMs
    this.tick()
  }

  status(): ReminderStatus {
    const settings = getSettings()
    const idleSec = powerMonitor.getSystemIdleTime()
    const awaySec = this.awaySec(settings)
    return {
      sedentary: {
        enabled: settings.sedentary.enabled,
        present: idleSec < awaySec,
        idleSec,
        activeMs: this.activeSince === 0 ? 0 : Date.now() - this.activeSince,
        remindMs: this.remindMs(settings),
        awaySec
      },
      water: {
        enabled: settings.water.enabled,
        nextAt: this.nextWaterAt,
        intervalMs: this.waterIntervalMs(settings)
      },
      dnd: notifier.isDnd,
      dndUntil: notifier.dndUntilAt,
      last: notifier.lastReminder
    }
  }

  // ---------------- 内部 ----------------

  private tick(): void {
    const now = Date.now()
    const settings = getSettings()
    const idleSec = powerMonitor.getSystemIdleTime()
    this.tickWater(now, idleSec, settings)
    this.tickSedentary(now, idleSec, settings)
  }

  private tickWater(now: number, idleSec: number, settings: AppSettings): void {
    if (!settings.water.enabled) {
      this.nextWaterAt = 0
      return
    }
    const intervalMs = this.waterIntervalMs(settings)
    if (this.nextWaterAt === 0) {
      // 刚启动 / 刚打开开关：先等一个完整间隔，避免"打开就立刻提醒"
      this.nextWaterAt = now + intervalMs
      return
    }
    if (now < this.nextWaterAt) return

    // 到点了但座位是空的就不弹 —— 对着空房间提醒没有意义。
    // 这里刻意【不推进排程】：用户回来时会立刻收到一次，而他确实该喝水了。
    if (idleSec >= WATER_PRESENCE_IDLE_SEC) return

    notifier.notify({
      kind: 'water',
      title: '该喝水啦',
      body: `已经 ${this.spanText(intervalMs)} 没喝水了，去接一杯吧`,
      petState: 'eat',
      petStateHoldMs: 3000
    })
    this.nextWaterAt = now + intervalMs
  }

  private tickSedentary(now: number, idleSec: number, settings: AppSettings): void {
    if (!settings.sedentary.enabled) {
      this.activeSince = 0
      return
    }

    if (idleSec >= this.awaySec(settings)) {
      if (this.activeSince !== 0) {
        log.info(`判定离开座位（已空闲 ${idleSec}s），久坐计时中断`)
      }
      this.activeSince = 0
      return
    }

    if (this.activeSince === 0) {
      this.activeSince = now
      return
    }

    const remindMs = this.remindMs(settings)
    if (now - this.activeSince < remindMs) return

    notifier.notify({
      kind: 'sedentary',
      title: '该起来动动了',
      body: `你已经连续坐了 ${this.spanText(remindMs)}，站起来走两步、伸个懒腰吧`,
      petState: 'rest',
      petStateHoldMs: 4000
    })
    // 提醒后重新起算。少了这一行，接下来每个 tick 都会再提醒一次（每 5 秒弹一次）
    this.activeSince = now
  }

  /** 开发期把「分钟」当「秒」用；见 REMIND_FAST_* 的注释 */
  private span(minutes: number, fastSec: number): number {
    return this.fast ? fastSec * 1000 : minutes * 60_000
  }

  private remindMs(settings: AppSettings): number {
    return this.span(settings.sedentary.remindMinutes, REMIND_FAST_SEDENTARY_SEC)
  }

  private awaySec(settings: AppSettings): number {
    return Math.round(this.span(settings.sedentary.idleMinutes, REMIND_FAST_AWAY_SEC) / 1000)
  }

  private waterIntervalMs(settings: AppSettings): number {
    return this.span(settings.water.intervalMin, REMIND_FAST_WATER_SEC)
  }

  /** 提醒文案里的时长。加速模式下会显示成秒，正好提醒"这是开发期加速" */
  private spanText(ms: number): string {
    return ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 1000)} 秒`
  }
}

export const reminderScheduler = new ReminderScheduler()
