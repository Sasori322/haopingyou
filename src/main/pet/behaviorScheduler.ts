import { BEHAVIOR_INTERVAL_MS } from '../../shared/constants'
import { createLogger } from '../utils/logger'

const log = createLogger('behavior')

export interface BehaviorHandlers {
  /** 当前是否处于「业务状态」中（专注 / 拖拽等），是则跳过自发行为 */
  isBusy(): boolean
  onIdle(): void
  onWalk(direction: -1 | 1, durationMs: number): void
  onSleep(): void
}

/**
 * 自发行为调度：用递归 setTimeout 随机排期，而不是固定 interval，行为更自然。
 */
export class BehaviorScheduler {
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(private readonly handlers: BehaviorHandlers) {}

  start(): void {
    if (this.running) return
    this.running = true
    log.info('自发行为调度已启动')
    this.schedule()
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private schedule(): void {
    if (!this.running) return
    const [min, max] = BEHAVIOR_INTERVAL_MS
    const delay = min + Math.random() * (max - min)
    this.timer = setTimeout(() => {
      this.timer = null
      this.tick()
      this.schedule()
    }, delay)
  }

  private tick(): void {
    if (!this.running || this.handlers.isBusy()) return
    const roll = Math.random()
    if (roll < 0.35) {
      const direction: -1 | 1 = Math.random() < 0.5 ? -1 : 1
      this.handlers.onWalk(direction, 2000 + Math.random() * 4000)
    } else if (roll < 0.55) {
      this.handlers.onSleep()
    } else {
      this.handlers.onIdle()
    }
  }
}
