import { Notification } from 'electron'
import type { PetState } from '../../shared/types/pet'
import type { DeliveredReminder, ReminderKind } from '../../shared/types/reminder'
import { petApp } from '../pet/petApp'
import { isPetVisible } from '../windows/petWindow'
import { createLogger } from '../utils/logger'
import { immersiveWatcher } from './immersiveWatcher'

const log = createLogger('notifier')

export interface ReminderRequest {
  kind: ReminderKind
  /**
   * 系统通知标题（事情本身，如"该喝水啦"）。
   * 投递时会自动加上「宠物昵称 · 」前缀，所以**这里不要再写宠物名**，
   * 否则会变成"橘子 · 橘子提醒你喝水"。
   */
  title: string
  /** 系统通知正文（建议带上具体数字，比如"已经 45 分钟"） */
  body: string
  /**
   * 宠物气泡台词。不传就走气泡表（`manifest.bubbles[kind]` → `DEFAULT_BUBBLES[kind]`），
   * 这样每个宠物能说自己的话，而不是所有提醒都是同一句。
   */
  bubble?: string
  /** 提醒时把宠物切到的状态（可选） */
  petState?: PetState
  petStateHoldMs?: number
  /**
   * 系统通知是否发声。只在**退回系统通知**那一路生效 —— 宠物气泡本身是无声的，
   * 所以正常情况下（宠物看得见）提醒是不响的。
   */
  sound?: boolean
}

/**
 * 提醒投递层：**"该提醒了"这件事只在这里往外发**。
 *
 * ## 为什么要有独立一层（而不是每个功能自己弹）
 * 久坐、喝水、番茄钟、待办截止四件事的触发条件完全不同，但**投递方式完全一样**：
 * 宠物气泡/状态 + 系统通知 + 托盘提示。分开写就是同一段逻辑抄四遍，
 * 而且"免打扰""沉浸时别打扰"这种横切规则会漏掉某一处。
 *
 * ## 默认让宠物说，系统通知只做兜底
 * **气泡是本体，系统通知是备用通道**，后者只在"说不了"时才发，共两种情况：
 * 1. 宠物被用户藏起来了 —— 气泡发了也看不见；
 * 2. 这个提醒类型没有气泡台词（`DEFAULT_BUBBLES` 里没这一项，比如尚未接线的番茄钟）。
 *
 * 为什么不默认出系统通知：通知顶部那行**应用署名**是 Windows 按 AUMID 解析出来的，
 * 粒度是"应用"而不是"通知"，**改不成宠物名** —— dev 态没有匹配的开始菜单快捷方式，
 * 就兜底显示宿主进程名 "Electron"；打包后会变成 productName（好屏友）。
 * 两种都不像"橘子在提醒你"，反而像第三方弹窗，还和气泡重复打扰。
 *
 * 但这一路**不能删**：托盘提示只在用户主动看托盘时才看得到，宠物被藏起来时
 * 系统通知是唯一还会自己冒出来的通道。
 *
 * ## 两条横切规则
 * 1. **免打扰 = 丢弃，不补发**。用户点"免打扰 1 小时"是明确意图，
 *    一小时后回来不该被攒下来的旧提醒炸一遍。
 * 2. **沉浸（游戏 / 全屏 / 手动安静）= 挂起，结束后补一次**。
 *    这时弹窗是纯打扰，但用户并没有说过"不要提醒"，所以只保留**最近一条**，
 *    等沉浸结束时补发 —— 攒一堆旧账回来一起弹同样是打扰。
 */
class Notifier {
  /** 免打扰结束的绝对时间戳；0 = 未开启 */
  private dndUntil = 0
  /** 沉浸期间挂起的提醒（只保留最近一条） */
  private pending: ReminderRequest | null = null
  private last: DeliveredReminder | null = null
  private supported = false
  private started = false

  /** 投递完成回调（index.ts 接到 refreshTray，让托盘提示跟着变） */
  onDelivered: (() => void) | null = null

  get isDnd(): boolean {
    return this.dndUntil > Date.now()
  }

  /** 免打扰结束时间戳；未开启时为 0 */
  get dndUntilAt(): number {
    return this.isDnd ? this.dndUntil : 0
  }

  get lastReminder(): DeliveredReminder | null {
    return this.last
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.supported = Notification.isSupported()
    if (!this.supported) {
      // 不打包运行（开发环境）时 Windows 常常找不到开始菜单快捷方式，通知会静默失败。
      // 这不是致命问题：宠物气泡与托盘提示两路照常工作，所以才要坚持三路并行。
      log.warn('系统通知不可用，提醒将只走宠物气泡与托盘提示')
    }
  }

  /** 手动免打扰；minutes = null 表示立刻恢复 */
  snooze(minutes: number | null): void {
    const next = minutes && minutes > 0 ? Date.now() + minutes * 60_000 : 0
    this.dndUntil = next
    if (next === 0) {
      log.info('已恢复提醒')
      this.flushPending()
    } else {
      log.info(`免打扰 ${minutes} 分钟`)
    }
    this.onDelivered?.()
  }

  /** 发起一次提醒。是否真的投递由这里的横切规则决定 */
  notify(request: ReminderRequest): void {
    if (this.isDnd) {
      log.info(`免打扰中，丢弃提醒：${request.kind}`)
      return
    }
    if (immersiveWatcher.isHidden) {
      this.pending = request
      log.info(`沉浸中，提醒延后到结束之后：${request.kind}`)
      return
    }
    this.deliver(request)
  }

  /** 沉浸结束 / 免打扰解除时调用，补发挂起的那一条 */
  flushPending(): void {
    const request = this.pending
    if (!request) return
    if (this.isDnd || immersiveWatcher.isHidden) return
    this.pending = null
    this.deliver(request)
  }

  // ---------------- 内部 ----------------

  private deliver(request: ReminderRequest): void {
    // 标题带上宠物昵称，让提醒读起来是"橘子在喊你"，而不是一条没有主语的系统弹窗。
    // 昵称口径统一走 petApp.displayName（读 manifest.nickname），不要在这里另取一处。
    const title = `${petApp.displayName} · ${request.title}`

    // 先说，说得出来就不弹通知（理由见类注释）。宠物被用户手动藏起来时跳过说话：
    // 气泡发了也看不见，状态切了也白切。
    const speakable = isPetVisible()
    let bubble: string | null = null
    if (speakable) {
      if (request.petState) {
        petApp.setState(request.petState, `remind:${request.kind}`, request.petStateHoldMs)
      }
      bubble = petApp.speak(request.kind, request.bubble)
    }

    // 兜底：没说出话（宠物藏着 / 该类型没台词）才走系统通知，否则会和气泡重复打扰
    if (bubble === null && this.supported) {
      try {
        new Notification({
          title,
          body: request.body,
          silent: !request.sound
        }).show()
      } catch (error) {
        log.warn('系统通知发送失败', error)
      }
    }

    this.last = {
      kind: request.kind,
      title,
      body: request.body,
      bubble,
      at: Date.now()
    }
    log.info(
      `提醒已投递：${request.kind} · ${title} —— ${request.body}${
        bubble ? ` · 宠物说「${bubble}」` : ' · 宠物不可见或无台词，改用系统通知'
      }`
    )
    this.onDelivered?.()
  }
}

export const notifier = new Notifier()
