import { screen } from 'electron'
import type { BrowserWindow } from 'electron'
import { isReminderKind, PRODUCT_NAME, REMINDER_BUBBLE_MS, SPEECH_BUBBLE_MS } from '../../shared/constants'
import { IPC } from '../../shared/ipc'
import type {
  ForceStatePayload,
  PetManifest,
  PetState,
  PointerSyncPayload,
  SpeakPayload
} from '../../shared/types/pet'
import { createLogger } from '../utils/logger'
import { getSettings } from '../services/settingsService'
import { BehaviorScheduler } from './behaviorScheduler'
import { PetController } from './petController'
import { getPet, toReloadPayload, type PetRecord } from './petLibrary'
import { onPetVisibilityChange, resizePetWindow } from '../windows/petWindow'

const log = createLogger('petApp')

/**
 * 素材未提供 bubbles 时的兜底台词，也用于占位宠物。
 *
 * **每类刻意给足 6~8 句**：`speak()` 只会避开「上一句」（`lastBubble`），
 * 池子小到 2~3 句时，连着点几下就会听出复读机循环 —— 台词表是内容而不是逻辑，
 * 多写几句几乎零成本，却是"像有个小活物陪着"和"像个按钮"的分界线。
 *
 * 内置的三只宠物（cat / siamese / dog）各有自己的性格台词，这份表只服务于
 * 自建素材的用户。两者 key 必须一致，新增 key 时两边一起补。
 */
const DEFAULT_BUBBLES: Record<string, string[]> = {
  idle: [
    '有点无聊…',
    '要不要歇一会儿？',
    '今天过得怎么样？',
    '我在这儿陪着你',
    '要不要摸摸我？',
    '发呆也是一种本事',
    '你忙你的，我看着',
    '一起伸个懒腰吧'
  ],
  click: [
    '别戳我啦，痒',
    '在的在的',
    '今天也要加油哦',
    '摸头要收费的',
    '再摸一下也不是不行',
    '干嘛呀，有事说事',
    '被戳中了…',
    '好啦，我在呢'
  ],
  drag: [
    '喂——放我下来！',
    '别晃了别晃了',
    '我恐高！',
    '要飞起来了！',
    '轻点轻点，抓疼了',
    '这是要带我去哪',
    '抓紧我，别摔了'
  ],
  drop: [
    '呼，就放这儿吧',
    '又把我扔这儿',
    '这个位置还不错',
    '站稳了，我没事',
    '落地成功！',
    '下次轻一点哦',
    '这儿风景挺好的'
  ],
  walk: [
    '出去遛遛',
    '走两步',
    '巡视一下领地',
    '活动活动腿脚',
    '我去转转，马上回来',
    '散个步，顺便巡逻'
  ],
  sleep: [
    '困了…先眯一会儿',
    'zzZ…',
    '别吵我哈',
    '睡一会儿，就一会儿',
    '梦见好吃的了…',
    '呼…呼…'
  ],
  eat: [
    '开饭啦！',
    '好吃好吃',
    '还有吗还有吗',
    '这个我最喜欢了',
    '嗝，吃撑了',
    '闻着就香'
  ],
  hot: [
    '有点烫…',
    '风扇都转起来了',
    '慢一点，我跟不上了',
    '机器好累，你也歇歇？',
    '热得我毛都炸了',
    '要不要关掉几个程序？'
  ],
  focus: [
    '我陪你一起专注',
    '别分心，我盯着你呢',
    '这段时间专心点哦',
    '安静干活，我不吵你',
    '专注的样子最好看',
    '我不动，你也不许摸鱼'
  ],
  rest: [
    '起来走两步吧',
    '该喝水啦！',
    '眼睛也该歇歇了',
    '伸伸懒腰，肩膀放松些',
    '歇一会儿，效率反而高',
    '我陪你一起放空'
  ],
  // 提醒类气泡。与状态同名不是巧合：`speak(kind)` 的 key 直接用提醒类型，
  // 这样每个宠物的 manifest 只要写了自己的 `bubbles.sedentary` 就能说话不一样。
  sedentary: [
    '起来走两步吧，我陪你',
    '坐太久啦，伸个懒腰？',
    '动一动，别僵住了',
    '站起来看看窗外吧',
    '腿脚该活动活动了',
    '我已经盯着你坐很久了',
    '起来晃晃，就一分钟',
    '一直坐着会长蘑菇的'
  ],
  water: [
    '该喝水啦！',
    '去接杯水吧，我也渴了',
    '喝口水，顺便看看远处',
    '水杯是不是空了？',
    '补水时间到',
    '喉咙该润一润啦',
    '喝一口，就一口',
    '接水的时候顺便走两步'
  ],
  todo: [
    '这件事到点啦，去做吧',
    '别忘了这件哦',
    '该收尾那件事啦',
    '到时间了，去把它搞定',
    '你答应过的，别拖啦',
    '这件事在等你',
    '现在就去做，回来我夸你'
  ],
  // 番茄钟尚未接线，台词先备好：接上 notifier 那天不用再补内容
  pomodoro: [
    '专注时间开始啦',
    '这一轮交给我看着',
    '开始了就别摸手机哦',
    '我在旁边陪着你',
    '倒计时开始，冲',
    '专心一会儿，休息我来提醒'
  ]
}

/**
 * 宠物应用编排层：状态机 + 气泡 + 素材切换 + 自发行为调度。
 *
 * 状态同步方向：主进程是「意图」的来源，渲染进程是「动画」的执行者。
 * 渲染进程只上报自身状态（click 等短动画结束），不自行决定业务状态。
 */
export class PetApp {
  readonly controller = new PetController()
  private readonly scheduler = new BehaviorScheduler({
    isBusy: () => this.busy,
    onIdle: () => this.setState('idle', 'schedule'),
    onWalk: (direction, durationMs) => this.startWalk(direction, durationMs),
    onSleep: () => this.setState('sleep', 'schedule')
  })

  private win: BrowserWindow | null = null
  private record: PetRecord | null = null
  private state: PetState = 'idle'
  private busy = false
  private lastBubble = ''
  private holdTimer: NodeJS.Timeout | null = null
  /** 状态变化的外界观察者（托盘 tooltip 等） */
  onStateChanged: ((state: PetState) => void) | null = null

  attach(win: BrowserWindow): void {
    this.win = win
    this.controller.attach(win)
    this.controller.onWalkFinished = () => {
      this.setState('idle', 'walk-finished')
    }
    this.controller.onDirectionChanged = (direction) => {
      this.send(IPC.PET_FORCE_STATE, {
        state: 'walk',
        reason: 'walk-turn',
        direction
      } satisfies ForceStatePayload)
    }
    // 藏 / 显宠物是穿透态最容易失配的两个时刻，统一在这里复位与重同步（详见 petWindow 的说明）
    onPetVisibilityChange((visible) => this.handlePetVisibility(visible))
    // 首次显示也要同步一次：开机时如果光标正好压在宠物身上，不会有任何 mousemove 产生，
    // 只等事件的话这一格永远不会被重新评估（窗口此刻还没显示，等 'show'）
    if (win.isVisible()) this.syncPointer()
    else win.once('show', () => this.syncPointer())
    this.scheduler.start()
    this.refreshRecording()
  }

  detach(): void {
    this.scheduler.stop()
    this.controller.detach()
    if (this.holdTimer) {
      clearTimeout(this.holdTimer)
      this.holdTimer = null
    }
    this.win = null
  }

  // ---------------- 宠物素材 ----------------

  get currentPetId(): string {
    return this.record?.id ?? ''
  }

  /**
   * 对外称呼：优先用户自定义的名字，其次昵称（"橘子"），再退成品名（"小橘猫"）。
   *
   * 系统通知、托盘提示这类「宠物在跟你说话」的场合统一走这里，不要再各自去读
   * `manifest.name` —— 否则加一只新宠物就会出现三处口径不一致（一处叫品种名、
   * 一处叫昵称）。宠物还没加载出来时兜底成产品名，通知至少不会是空的。
   */
  get displayName(): string {
    const manifest = this.record?.manifest
    const custom = this.record ? getSettings().petNames?.[this.record.id]?.trim() : ''
    return custom || manifest?.nickname || manifest?.name || PRODUCT_NAME
  }

  get manifest(): PetManifest | null {
    return this.record?.manifest ?? null
  }

  get currentState(): PetState {
    return this.state
  }

  /** 重新读盘并同步给渲染层 */
  refreshRecording(): void {
    const payload = toReloadPayload(this.record)
    this.send(IPC.PET_RELOAD, payload)
    log.info('当前宠物：', payload.petId || '(无)', '素材齐全：', payload.hasAssets)
  }

  loadPet(petId: string): boolean {
    const record = getPet(petId)
    if (!record) {
      log.warn('未找到宠物：', petId)
      this.record = null
      this.refreshRecording()
      return false
    }
    const changed = this.record?.id !== record.id
    this.record = record
    if (changed) {
      this.stopHold()
      this.state = 'idle'
    }
    // 不同宠物可能用不同画布（悬空姿态比站立高得多），窗口尺寸必须跟着走
    resizePetWindow(record.manifest.canvas)
    this.refreshRecording()
    // 画布变了 → 命中框也变了；光标可能停在原地，靠事件不会重算
    this.syncPointer()
    return true
  }

  // ---------------- 穿透态重同步 ----------------

  /** 藏 / 显宠物时的穿透态处理（由 petWindow 的可见性钩子调用） */
  private handlePetVisibility(visible: boolean): void {
    if (!visible) {
      // 藏之前必须把窗口确定性置回穿透：否则隐藏前的"可交互"会被原样带回来，
      // 渲染层与主进程都以为自己可交互 → 唯一的恢复路径因"值没变"变成空操作 → 点不动
      this.controller.forceIgnoreMouse()
      // 这行是「宠物被藏过一次之后点不动」这类报障的第一手证据：先看它有没有出现，
      // 再看后面的重同步；如果只有"隐藏"没有"显示"，说明恢复路径本身没走到
      log.info('宠物可见性 → 隐藏（已强制回穿透）')
      return
    }
    this.syncPointer()
    log.info('宠物可见性 → 显示（已重同步指针）')
  }

  /**
   * 指针重同步：用主进程手里的全局光标位置，让渲染层**无条件**重算一次命中并落地穿透态。
   *
   * 两个必须由主进程出面的理由：
   * 1) 渲染层拿不到全局光标位置——宠物窗口是「穿透 + forward」的，只有光标落进窗口矩形时
   *    才收得到 mousemove；
   * 2) 窗口重新显示 / 系统唤醒 / 切换宠物之后，光标可能**已经**压在宠物身上却因为没动过
   *    而不产生任何 mousemove，于是穿透态永远停在"穿透"。
   *
   * 坐标用 DIP，与渲染层的 clientX/clientY（CSS px）同系；窗口是 `frame: false`，
   * `getBounds()` 的原点即客户区原点，不需要再减边框。
   */
  syncPointer(): void {
    const win = this.win
    if (!win || win.isDestroyed() || !win.isVisible()) return
    const bounds = win.getBounds()
    const cursor = screen.getCursorScreenPoint()
    this.send(IPC.PET_POINTER_SYNC, {
      x: cursor.x - bounds.x,
      y: cursor.y - bounds.y
    } satisfies PointerSyncPayload)
  }

  // ---------------- 状态机 ----------------

  private getStateHold(): number {
    if (!this.record) return 0
    const anim = this.record.manifest.animations[this.state]
    return anim && !anim.loop ? Math.ceil((anim.frames / Math.max(1, anim.fps)) * 1000) + 80 : 0
  }

  setState(state: PetState, reason = 'manual', holdMs?: number): void {
    const anim = this.record?.manifest.animations[state]
    // reason='debug' 是 HPY_FORCE_STATE 诊断钩子：跳过可打断性检查，
    // 否则钉不可打断状态（drag）时，200ms 的重设定时器与推迟逻辑互相踩，永远切不进去
    if (reason !== 'debug' && anim && !anim.interruptible && this.state !== state) {
      // 当前状态不可打断，推迟到 hold 结束后再切
      const wait = holdMs ?? this.getStateHold()
      this.stopHold()
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null
        this.setState(state, reason)
      }, Math.max(60, wait))
      return
    }
    this.beginHoldIfNeeded(holdMs)
    const changed = this.state !== state
    this.state = state
    this.busy = state === 'drag' || state === 'click' || state === 'focus' || state === 'eat'
    const payload: ForceStatePayload = {
      state,
      reason,
      holdMs,
      direction: state === 'walk' ? this.controller.direction : 0
    }
    this.send(IPC.PET_FORCE_STATE, payload)
    if (changed) {
      log.info('状态 →', state, `(${reason})`)
      this.onStateChanged?.(state)
    }
  }

  private beginHoldIfNeeded(holdMs?: number): void {
    const hold = holdMs ?? 0
    if (hold <= 0) return
    this.stopHold()
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null
    }, hold)
  }

  private stopHold(): void {
    if (this.holdTimer) {
      clearTimeout(this.holdTimer)
      this.holdTimer = null
    }
  }

  // ---------------- 行为 ----------------

  startWalk(direction: -1 | 1, durationMs: number): void {
    if (this.controller.isDragging) return
    // 顺序不能反：setState 组装的 payload 里 direction 读的是 controller 的当前值，
    // 先 setState 会把【上一段走动】的方向发下去，渲染层据此翻面 → 倒着走，
    // 而且要到撞上屏幕边界触发 walk-turn 才会纠正。
    this.controller.startWalk(direction, durationMs)
    this.setState('walk', 'schedule')
  }

  idle(): void {
    this.controller.stopWalk()
    this.setState('idle', 'manual')
  }

  sleep(): void {
    this.controller.stopWalk()
    this.setState('sleep', 'manual')
  }

  eat(): void {
    this.controller.stopWalk()
    this.setState('eat', 'menu', 1500)
    this.speak('eat')
  }

  // ---------------- 拖拽 ----------------

  handleDragStart(offset: { x: number; y: number }): void {
    this.controller.startDrag(offset)
    this.setState('drag', 'user', 600)
  }

  handleDragEnd(): void {
    this.controller.endDrag()
    this.setState('idle', 'user')
    this.speak('drop')
  }

  // ---------------- 气泡 ----------------

  /**
   * 让宠物说一句话。
   *
   * 返回值是**实际说出的那一句**（没说出来则 null）。调用方需要知道具体说了什么时
   * 只能靠它：气泡文案来自 manifest / 兜底表并且是随机挑的，
   * 不返回的话调用方（提醒投递层要把它记进状态与托盘提示）只能自己再猜一遍。
   */
  speak(reason: string, text?: string): string | null {
    const lines = text
      ? [text]
      : (this.record?.manifest.bubbles?.[reason] ?? DEFAULT_BUBBLES[reason] ?? [])
    if (lines.length === 0) return null
    const candidates = lines.length > 1 ? lines.filter((line) => line !== this.lastBubble) : lines
    const picked = candidates[Math.floor(Math.random() * candidates.length)]
    if (!picked) return null
    this.lastBubble = picked
    // 提醒说久一点（8 秒 vs 闲聊 3.2 秒）。这不是"更显眼一点"的调参，而是功能需要：
    // 提醒的目的是让用户**离开当前窗口去做别的事**，而闲聊只需要被余光扫到。
    // 时长、配色、宠物动作三件事都在渲染层按同一个 `reason` 分叉，这里是唯一给出时长的地方。
    const payload: SpeakPayload = {
      text: picked,
      ms: isReminderKind(reason) ? REMINDER_BUBBLE_MS : SPEECH_BUBBLE_MS,
      reason
    }
    this.send(IPC.PET_SPEAK, payload)
    return picked
  }

  // ---------------- 渲染层反馈 ----------------

  handleRendererState(state: PetState): void {
    if (state === 'click') {
      this.speak('click')
      return
    }
    if (state === 'idle' && (this.state === 'click' || this.state === 'eat')) {
      this.setState('idle', 'renderer')
    }
  }

  // ---------------- 工具 ----------------

  private send(channel: string, payload: unknown): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    win.webContents.send(channel, payload)
  }
}

export const petApp = new PetApp()
