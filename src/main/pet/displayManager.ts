import { screen } from 'electron'
import type { Rectangle } from 'electron'

export interface Placement {
  workArea: Rectangle
  /** 窗口可停留的最低 y（DIP）：工作区底部减窗口高度 */
  groundY: number
  /** 窗口可停留的最小 x */
  minX: number
  /** 窗口可停留的最大 x */
  maxX: number
}

/**
 * 按窗口中心点归属屏幕，并给出该窗口可停留的坐标范围。
 * 必须用 workArea（已排除任务栏/停靠的 AppBar），用 bounds 会让宠物钻到任务栏下面。
 */
export function placementFor(centerX: number, centerY: number, winW: number, winH: number): Placement {
  const display = screen.getDisplayNearestPoint({
    x: Math.round(centerX),
    y: Math.round(centerY)
  })
  const workArea = display.workArea
  return {
    workArea,
    groundY: workArea.y + workArea.height - winH,
    minX: workArea.x,
    maxX: Math.max(workArea.x, workArea.x + workArea.width - winW)
  }
}

/** 主屏上默认的落点（右下角一带，不遮挡常用操作区） */
export function primaryDropPoint(winH: number): { x: number; y: number } {
  const workArea = screen.getPrimaryDisplay().workArea
  return {
    x: Math.round(workArea.x + workArea.width * 0.72),
    y: Math.round(workArea.y + workArea.height - winH)
  }
}
