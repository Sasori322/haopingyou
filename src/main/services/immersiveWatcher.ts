import { IMMERSIVE_SETTLE_MS, IMMERSIVE_SUPPRESS_MS } from '../../shared/constants'
import type { ImmersiveStatus } from '../../shared/types/pet'
import { petApp } from '../pet/petApp'
import { getPetWindow, isPetVisible, setPetVisible } from '../windows/petWindow'
import { createLogger } from '../utils/logger'
import { foregroundProbe } from './foregroundProbe'
import { getSettings } from './settingsService'

const log = createLogger('immersive')

/** 评估周期（ms）。只读内存里的快照，没有任何 I/O，所以可以做得比采样周期快 */
const TICK_MS = 500

/**
 * 沉浸躲开：看视频 / 打游戏 / 演示时让宠物自动让路。
 *
 * ## 三个触发器
 * 1. **名单进程在运行**——用户在设置里填进程名（支持 `*` 通配），如游戏 exe
 * 2. **前台窗口铺满整屏**——由 `foregroundProbe` 报矩形，这里用 Electron 的 screen API 判定
 * 3. **手动安静**——托盘 / 右键菜单里的「安静一会儿」，不落盘、重启即失效
 *
 * ## 两条必须守住的规则
 * - **绝不覆写用户的可见性设置**。隐藏走的是「临时隐藏」，恢复时读的是
 *   `settings.petVisible`（用户意图），而不是无脑 `true`。否则用户在托盘里关掉宠物，
 *   过一会儿它自己又冒出来了。
 * - **一切切换都要过防抖**（`IMMERSIVE_SETTLE_MS`）。没有它，alt-tab、进程起停、
 *   全屏切换的边缘抖动会让宠物反复闪。
 */
class ImmersiveWatcher {
  private timer: NodeJS.Timeout | null = null
  /** 当前是否由本模块隐藏了宠物 */
  private hidden = false
  /** 原始条件是否成立（未过防抖） */
  private raw = false
  /** 原始条件最近一次变化的时间 */
  private rawSince = 0
  private quietUntil = 0
  private suppressUntil = 0
  private reason = ''

  /** 可见性变化回调（index.ts 接到 refreshTray，让托盘文案跟着变） */
  onVisibilityChanged: ((hidden: boolean) => void) | null = null

  get isHidden(): boolean {
    return this.hidden
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.evaluate(), TICK_MS)
    this.rawSince = Date.now()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.hidden) {
      this.hidden = false
      this.reason = ''
      setPetVisible(getSettings().petVisible)
    }
  }

  /** 设置变化后调用：把依赖同步给探针，并立刻重新评估一次 */
  refresh(): void {
    const settings = getSettings()
    const needProbe =
      settings.immersive.enabled &&
      (settings.immersive.autoDetect || settings.immersive.processes.length > 0)
    foregroundProbe.refresh(needProbe, needProbe ? settings.immersive.processes : [])
    this.evaluate()
  }

  /** 手动安静若干分钟；传 null 表示取消 */
  quiet(minutes: number | null): void {
    this.quietUntil = minutes && minutes > 0 ? Date.now() + minutes * 60 * 1000 : 0
    log.info(minutes ? `手动安静 ${minutes} 分钟` : '已取消手动安静')
    this.evaluate()
  }

  /**
   * 用户主动把宠物叫回来（托盘「显示宠物」/ 设置里打开开关）时调用。
   * 不是为了"记住"状态，而是给出一个豁免窗口——否则下一个 tick 就会把它再藏起来，
   * 表现为"点了没反应"。
   */
  suppress(ms = IMMERSIVE_SUPPRESS_MS): void {
    this.quietUntil = 0
    this.suppressUntil = Date.now() + ms
    this.evaluate()
  }

  status(): ImmersiveStatus {
    return {
      hidden: this.hidden,
      reason: this.reason,
      probeRunning: foregroundProbe.isRunning,
      probeAvailable: foregroundProbe.isAvailable
    }
  }

  // ---------------- 内部 ----------------

  private evaluate(): void {
    const settings = getSettings()
    if (!settings.immersive.enabled) {
      this.settle(false, [])
      return
    }

    const now = Date.now()
    const triggers: string[] = []

    if (now < this.quietUntil) triggers.push('手动安静')

    if (settings.immersive.processes.length > 0) {
      const hits = foregroundProbe.lastSnapshot?.hits ?? []
      if (hits.length > 0) triggers.push(`正在运行 ${hits.join('、')}`)
    }

    if (settings.immersive.autoDetect && foregroundProbe.isForegroundFullscreen()) {
      triggers.push('全屏应用')
    }

    const raw = triggers.length > 0 && now >= this.suppressUntil
    if (raw !== this.raw) {
      this.raw = raw
      this.rawSince = now
    }
    this.settle(raw, triggers)
  }

  private settle(target: boolean, triggers: string[]): void {
    if (this.hidden) this.reason = target ? triggers.join(' + ') : this.reason
    if (target === this.hidden) {
      if (!target) this.reason = ''
      return
    }
    if (Date.now() - this.rawSince < IMMERSIVE_SETTLE_MS) return
    this.apply(target, triggers)
  }

  private apply(hidden: boolean, triggers: string[]): void {
    const win = getPetWindow()
    if (!win || win.isDestroyed()) return
    // 用户正拎着宠物时不要抢：把手里的东西藏起来太粗暴，下一轮再判
    if (hidden && petApp.controller.isDragging) return

    this.hidden = hidden
    if (hidden) {
      this.reason = triggers.join(' + ')
      setPetVisible(false)
      // 带上窗口真实可见性：这条日志是"宠物到底藏没藏住"的第一手证据，
      // 报障时先看它，能一眼分开"没触发"和"触发了但窗口没藏住"
      log.info('沉浸躲开 →', this.reason, `· 窗口可见：${isPetVisible()}`)
    } else {
      this.reason = ''
      const intent = getSettings().petVisible
      setPetVisible(intent)
      log.info('沉浸结束，恢复显示（用户意图：', intent, `· 窗口可见：${isPetVisible()}）`)
    }
    this.onVisibilityChanged?.(hidden)
  }
}

export const immersiveWatcher = new ImmersiveWatcher()
