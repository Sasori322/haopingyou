import { screen } from 'electron'
import { GAZE_FACING_DEADZONE, GAZE_POLL_MS } from '../../shared/constants'
import { IPC } from '../../shared/ipc'
import type { GazePayload } from '../../shared/types/pet'
import { getPetWindow } from '../windows/petWindow'
import { createLogger } from '../utils/logger'
import { getSettings } from './settingsService'

const log = createLogger('gaze')

/** 量化档位：把 -1..1 切成 32 档，避免光标每动 1px 就产生一条 IPC */
const QUANT = 16

/**
 * 鼠标跟随采样器。
 *
 * **为什么必须由主进程做**：宠物窗口是「穿透 + forward」的，渲染层只在光标落在窗口矩形内时
 * 才会收到 mousemove，拿不到全局光标位置。`screen.getCursorScreenPoint()` 是 Electron 自带的
 * 系统调用，不需要任何原生模块。
 *
 * 三条约束：
 * 1) 只在**量化后的取值变化**时才发 IPC —— 光标不动时一条消息都不发；
 * 2) 窗口不可见时直接跳过，避免做无用功（也避免沉浸躲开后还在采样）；
 * 3) 观察点取「窗口水平中心、高度 30% 处」（约等于宠物的胸口/头部），不是窗口左上角。
 *
 * 距离衰减：权重 = 1 - 距离/半径，贴得越近权重越高，超出半径归零
 * → 宠物自然回到中立姿态，而不是一直撇着。
 */
class GazeWatcher {
  private timer: NodeJS.Timeout | null = null
  private lastKey = ''
  private lastSent: GazePayload | null = null

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), GAZE_POLL_MS)
    log.info('鼠标跟随已启动', `${GAZE_POLL_MS}ms/次`)
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
    log.info('鼠标跟随已停止')
  }

  /** 设置变化后调用：开关跟着设置走，并复位一次朝向，避免宠物"撇着不动" */
  refresh(): void {
    if (getSettings().gaze.enabled) {
      this.start()
      return
    }
    this.stop()
    this.reset()
  }

  /** 回到中立姿态（只发一次） */
  private reset(): void {
    const neutral: GazePayload = { x: 0, y: 0, near: false, facing: 0 }
    const key = 'neutral'
    if (this.lastKey === key) return
    this.lastKey = key
    this.send(neutral)
  }

  private tick(): void {
    const win = getPetWindow()
    if (!win || win.isDestroyed() || !win.isVisible()) return

    const settings = getSettings()
    const cursor = screen.getCursorScreenPoint()
    const bounds = win.getBounds()

    const originX = bounds.x + bounds.width / 2
    const originY = bounds.y + bounds.height * 0.3
    const dx = cursor.x - originX
    const dy = cursor.y - originY
    const distance = Math.hypot(dx, dy)

    const range = Math.max(80, settings.gaze.range)
    const weight = distance >= range ? 0 : 1 - distance / range
    const ux = distance > 0.5 ? dx / distance : 0
    const uy = distance > 0.5 ? dy / distance : 0

    const x = Math.round(ux * weight * QUANT) / QUANT
    const y = Math.round(uy * weight * QUANT) / QUANT
    const near = weight > 0
    const facing: -1 | 0 | 1 =
      settings.gaze.flipFacing && near && Math.abs(dx) > GAZE_FACING_DEADZONE
        ? dx < 0
          ? -1
          : 1
        : 0

    const key = `${x}|${y}|${near}|${facing}`
    if (key === this.lastKey) return
    this.lastKey = key
    if (process.env['HPY_DEBUG_GAZE']) {
      // 开发期诊断：只打印取值变化的那几帧，用来核对"倾斜方向是朝光标"这类符号问题
      log.info(
        `采样 光标 ${cursor.x},${cursor.y} 原点 ${Math.round(originX)},${Math.round(originY)}`,
        `d ${Math.round(dx)},${Math.round(dy)} 距离 ${Math.round(distance)}`,
        `→ ${JSON.stringify({ x, y, near, facing })}`
      )
    }
    this.send({ x, y, near, facing })
  }

  private send(payload: GazePayload): void {
    const win = getPetWindow()
    if (!win || win.isDestroyed()) return
    this.lastSent = payload
    win.webContents.send(IPC.PET_GAZE, payload)
  }

  /** 诊断用：最近一次下发的方位 */
  get lastPayload(): GazePayload | null {
    return this.lastSent
  }
}

export const gazeWatcher = new GazeWatcher()
