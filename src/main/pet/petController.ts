import { screen } from 'electron'
import type { BrowserWindow } from 'electron'
import {
  DRAG_THROTTLE_MS,
  LEAVE_DEBOUNCE_MS,
  WALK_SPEED,
  WALK_TICK_MS
} from '../../shared/constants'
import type { PetGeometry } from '../../shared/types/pet'
import { clamp } from '../utils/clamp'
import { createLogger } from '../utils/logger'
import { throttleTrailing } from '../utils/throttle'
import { placementFor } from './displayManager'

const log = createLogger('petController')

export interface Point {
  x: number
  y: number
}

/**
 * 负责宠物窗口的位置、穿透状态、拖拽与走动。
 *
 * 关键约束：
 * 1) setIgnoreMouseEvents 只在「进入命中区」「离开命中区」两个边沿调用，且做去重 ——
 *    Windows 上高频调用会引发 DWM 重合成风暴，表现为全系统鼠标卡顿。
 * 2) setPosition 只传 DIP 整数，否则 1px 抖动会让画面糊。
 * 3) 所有坐标一律 DIP，不混用物理像素。
 * 4) 高度只由用户决定：松手即停（不落体），走动也只做水平位移、保持当前高度。
 *    主进程只会把窗口「夹回工作区」防越界，绝不主动改变 y。
 */
export class PetController {
  private win: BrowserWindow | null = null
  /** true = 穿透（鼠标事件交给下层窗口），false = 接收鼠标事件 */
  private ignoreMouse = true
  private ignoreTimer: NodeJS.Timeout | null = null
  private dragging = false
  /** 拖拽期间锁死交互态，避免光标瞬时离开导致穿透回滚把拖拽打断 */
  private interactionLocked = false
  private dragOffset: Point = { x: 0, y: 0 }
  private lastPosition: Point = { x: Number.NaN, y: Number.NaN }
  private walkTimer: NodeJS.Timeout | null = null
  private walkDir: -1 | 1 = 1
  private throttledDragMove: ((pos: Point) => void) | null = null

  /** 一段走动自然结束时回调 */
  onWalkFinished: (() => void) | null = null
  /** 走到屏幕边界掉头时回调，用于通知渲染层翻转朝向 */
  onDirectionChanged: ((direction: -1 | 1) => void) | null = null

  attach(win: BrowserWindow): void {
    this.win = win
    this.ignoreMouse = true
    this.dragging = false
    this.interactionLocked = false
    const [x, y] = win.getPosition()
    this.lastPosition = { x, y }
    // 渲染层已按 30fps 节流上报，这里再兜一层，防止异常高频 IPC 打爆主进程
    this.throttledDragMove = throttleTrailing((pos: Point) => this.applyDragMove(pos), DRAG_THROTTLE_MS)
  }

  detach(): void {
    this.stopWalk()
    if (this.ignoreTimer) {
      clearTimeout(this.ignoreTimer)
      this.ignoreTimer = null
    }
    this.win = null
    this.throttledDragMove = null
  }

  get isDragging(): boolean {
    return this.dragging
  }

  get isWalking(): boolean {
    return this.walkTimer !== null
  }

  get direction(): -1 | 1 {
    return this.walkDir
  }

  get isIgnoringMouse(): boolean {
    return this.ignoreMouse
  }

  // ---------------- 穿透 ----------------

  private applyIgnore(ignore: boolean): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    if (ignore === this.ignoreMouse) return // 去重
    this.ignoreMouse = ignore
    // 开发期诊断：穿透态只在「进入/离开命中区」两个边沿切换，所以这条日志的条数
    // 与用户鼠标行为同阶，不会刷屏。排「宠物点不动」时先看它：
    // 如果显示之后一直停在"穿透"没回到"可交互"，就是握手回边断了。
    if (process.env['HPY_DEBUG_POINTER']) log.info(`穿透态 → ${ignore ? '穿透' : '可交互'}`)
    if (ignore) win.setIgnoreMouseEvents(true, { forward: true })
    else win.setIgnoreMouseEvents(false)
  }

  /** 渲染层根据命中判定请求切换穿透；进入立即生效、离开防抖 */
  requestIgnoreMouse(ignore: boolean): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    if (this.interactionLocked && ignore) return
    if (!ignore) {
      if (this.ignoreTimer) {
        clearTimeout(this.ignoreTimer)
        this.ignoreTimer = null
      }
      this.applyIgnore(false)
      return
    }
    if (this.ignoreTimer) clearTimeout(this.ignoreTimer)
    this.ignoreTimer = setTimeout(() => {
      this.ignoreTimer = null
      this.applyIgnore(true)
    }, LEAVE_DEBOUNCE_MS)
  }

  /** 强制回穿透（隐藏宠物、切换宠物时使用） */
  forceIgnoreMouse(): void {
    if (this.ignoreTimer) {
      clearTimeout(this.ignoreTimer)
      this.ignoreTimer = null
    }
    this.applyIgnore(true)
  }

  // ---------------- 位置 ----------------

  private setPosition(x: number, y: number): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    const rx = Math.round(x)
    const ry = Math.round(y)
    if (rx === this.lastPosition.x && ry === this.lastPosition.y) return
    this.lastPosition = { x: rx, y: ry }
    win.setPosition(rx, ry)
  }

  /**
   * 把窗口夹进所在屏幕的工作区，**只防越界、不改变高度语义**。
   *
   * 上边界取 workArea.y（避免钻到顶部任务栏 / 停靠栏底下），
   * 下边界取 groundY（工作区底部减窗口高度，即窗口能到达的最低位置）。
   */
  private clampIntoWorkArea(x: number, y: number, winW: number, winH: number): Point {
    const placement = placementFor(x + winW / 2, y + winH / 2, winW, winH)
    return {
      x: clamp(x, placement.minX, placement.maxX),
      y: clamp(y, placement.workArea.y, placement.groundY)
    }
  }

  /** DPI / 分辨率 / 任务栏变化、睡眠唤醒后夹回可视区（保持当前高度，不再强制贴地） */
  reclamp(): void {
    const win = this.win
    if (!win || win.isDestroyed() || this.dragging) return
    const [w, h] = win.getSize()
    const [x, y] = win.getPosition()
    const keep = this.clampIntoWorkArea(x, y, w, h)
    this.setPosition(keep.x, keep.y)
  }

  // ---------------- 拖拽 ----------------

  startDrag(offset: Point): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    this.stopWalk()
    this.dragging = true
    this.interactionLocked = true
    this.dragOffset = { x: Math.round(offset.x), y: Math.round(offset.y) }
    win.setAlwaysOnTop(true, 'screen-saver')
    log.info('开始拖拽', this.dragOffset)
  }

  /** 渲染层 30fps 节流调用；主进程侧再兜一层节流 */
  dragMove(pos: Point): void {
    if (!this.dragging || !this.throttledDragMove) return
    this.throttledDragMove(pos)
  }

  private applyDragMove(pos: Point): void {
    const win = this.win
    if (!win || win.isDestroyed() || !this.dragging) return
    const [w, h] = win.getSize()
    const next = this.clampIntoWorkArea(pos.x - this.dragOffset.x, pos.y - this.dragOffset.y, w, h)
    this.setPosition(next.x, next.y)
  }

  /**
   * 松手即停：窗口就留在拖放位置，不做落体插值。
   * 这里只补一次工作区夹取，覆盖「拖拽途中屏幕/DPI 变化导致坐标系错位」的边界情况。
   */
  endDrag(): void {
    if (!this.dragging) return
    this.dragging = false
    this.interactionLocked = false
    const win = this.win
    if (win && !win.isDestroyed()) {
      const [w, h] = win.getSize()
      const [x, y] = win.getPosition()
      const keep = this.clampIntoWorkArea(x, y, w, h)
      this.setPosition(keep.x, keep.y)
    }
    log.info('结束拖拽')
  }

  // ---------------- 走动 ----------------

  startWalk(direction: -1 | 1, durationMs: number): void {
    // 方向是「意图」，必须最先落地：调用方紧接着就会读 direction 去组装状态下发给渲染层，
    // 若放在下面（窗口判空之后）赋值，一旦走到早退分支就会把上一段走动的旧方向发下去，
    // 表现为宠物朝右面向却向左位移 —— 也就是「倒着走」。
    this.walkDir = direction

    const win = this.win
    if (!win || win.isDestroyed()) return
    this.stopWalk()

    // 走动只是水平位移：保留当前高度，不把它拉回地面
    const [w0, h0] = win.getSize()
    const [x0, y0] = win.getPosition()
    const start = this.clampIntoWorkArea(x0, y0, w0, h0)
    this.setPosition(start.x, start.y)

    const step = Math.max(1, Math.round((WALK_SPEED * WALK_TICK_MS) / 1000))
    const deadline = Date.now() + durationMs

    this.walkTimer = setInterval(() => {
      const win2 = this.win
      if (!win2 || win2.isDestroyed()) {
        this.stopWalk()
        return
      }
      const [w, h] = win2.getSize()
      const [x, y] = win2.getPosition()
      const placement = placementFor(x + w / 2, y + h / 2, w, h)
      let nextX = x + this.walkDir * step
      if (nextX <= placement.minX) {
        nextX = placement.minX
        if (this.walkDir !== 1) {
          this.walkDir = 1
          this.onDirectionChanged?.(1)
        }
      } else if (nextX >= placement.maxX) {
        nextX = placement.maxX
        if (this.walkDir !== -1) {
          this.walkDir = -1
          this.onDirectionChanged?.(-1)
        }
      }
      this.setPosition(nextX, clamp(y, placement.workArea.y, placement.groundY))
      if (Date.now() >= deadline) {
        this.stopWalk()
        this.onWalkFinished?.()
      }
    }, WALK_TICK_MS)
  }

  stopWalk(): void {
    if (!this.walkTimer) return
    clearInterval(this.walkTimer)
    this.walkTimer = null
  }

  // ---------------- 查询 ----------------

  getGeometry(): PetGeometry | null {
    const win = this.win
    if (!win || win.isDestroyed()) return null
    const [width, height] = win.getSize()
    const [x, y] = win.getPosition()
    const placement = placementFor(x + width / 2, y + height / 2, width, height)
    const scaleFactor = screen.getDisplayMatching(win.getBounds()).scaleFactor
    return {
      x,
      y,
      width,
      height,
      dpr: scaleFactor,
      workArea: {
        x: placement.workArea.x,
        y: placement.workArea.y,
        width: placement.workArea.width,
        height: placement.workArea.height
      }
    }
  }
}
