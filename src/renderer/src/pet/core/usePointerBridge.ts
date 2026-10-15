import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Ref } from 'vue'
import { DRAG_THRESHOLD_PX, DRAG_THROTTLE_MS } from '@shared/constants'
import { hitTest, type HitRect } from './hitTest'

export interface PointerBridgeOptions {
  /** 返回当前命中矩形（DIP，窗口坐标系） */
  getHitRect: () => HitRect
  /** 单击（未越过拖拽阈值） */
  onClick: () => void
  onDragStart: () => void
  onDragEnd: () => void
}

export interface PointerBridge {
  hovering: Ref<boolean>
  dragging: Ref<boolean>
}

/**
 * 两段式点击穿透的渲染层实现。
 *
 * 常态下窗口处于「穿透 + forward」状态：
 *   - 点击会落到下层窗口（桌面图标等），宠物不会拦截鼠标
 *   - 但 Electron 仍会把 mousemove 转发过来，我们据此判断光标是否压在宠物身上
 * 一旦命中，立即把窗口切回「接收鼠标」状态，之后的 mousedown / contextmenu 才会真正到达这里。
 *
 * 注意：切换只发生在「进入命中区」「离开命中区」两个边沿，绝不放在 rAF 或每次 mousemove 里，
 * 否则 Windows 上会引发 DWM 重合成风暴，表现为全系统鼠标卡顿。
 */
export function usePointerBridge(options: PointerBridgeOptions): PointerBridge {
  const hovering = ref(false)
  const dragging = ref(false)

  let interactive = false
  let pressed = false
  let pressOffset = { x: 0, y: 0 }
  let lastDragAt = 0
  let disposePointerSync: (() => void) | null = null

  function setInteractive(next: boolean): void {
    if (interactive === next) return
    interactive = next
    hovering.value = next
    window.petAPI.setIgnoreMouse(!next)
  }

  /**
   * 指针重同步：主进程在「窗口重新显示 / 系统唤醒 / 切换宠物」之后主动下发一次光标位置，
   * 这里**无条件**重算命中并落地穿透态。
   *
   * 与 `setInteractive` 的关键区别是**不复用缓存**：`setInteractive` 对"值没变"直接 return，
   * 而窗口被藏过一次再出来时，两边都可能停在"我以为我已经是可交互"，那条唯一的恢复消息
   * 就会因为值没变而永远不发 → 宠物看得见却点不动、拖不动。
   *
   * 顺带清掉可能残留的「按下态」：按下期间窗口被藏掉的话，mouseup 永远不会到达，
   * 之后第一下移动就会拿着一个过期的按点直接触发拖拽（宠物瞬移到光标下）。
   */
  function applyPointer(clientX: number, clientY: number): void {
    // 真在拖拽中就不抢：拖拽是有主进程 interactionLocked 保护的，不能被同步打断
    if (dragging.value) return
    pressed = false
    const inside = hitTest(options.getHitRect(), clientX, clientY)
    interactive = inside
    hovering.value = inside
    window.petAPI.setIgnoreMouse(!inside)
  }

  function isInside(event: MouseEvent): boolean {
    return hitTest(options.getHitRect(), event.clientX, event.clientY)
  }

  function handleMouseMove(event: MouseEvent): void {
    if (dragging.value) {
      const now = performance.now()
      if (now - lastDragAt >= DRAG_THROTTLE_MS) {
        lastDragAt = now
        window.petAPI.dragMove({ x: event.screenX, y: event.screenY })
      }
      return
    }

    if (pressed) {
      const dx = event.clientX - pressOffset.x
      const dy = event.clientY - pressOffset.y
      if (Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
        dragging.value = true
        window.petAPI.dragStart(pressOffset)
        options.onDragStart()
      }
      return
    }

    setInteractive(isInside(event))
  }

  function handleMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return
    if (!isInside(event)) return
    pressed = true
    pressOffset = { x: event.clientX, y: event.clientY }
    // 先预置为可交互，避免用户「第一下点击被吞掉」
    setInteractive(true)
  }

  function handleMouseUp(event: MouseEvent): void {
    if (!pressed) return
    const wasDragging = dragging.value
    pressed = false
    dragging.value = false

    if (wasDragging) {
      window.petAPI.dragMove({ x: event.screenX, y: event.screenY })
      window.petAPI.dragEnd()
      options.onDragEnd()
    } else {
      options.onClick()
    }
    setInteractive(isInside(event))
  }

  function handleMouseLeave(): void {
    if (pressed) return
    setInteractive(false)
  }

  function handleContextMenu(event: MouseEvent): void {
    event.preventDefault()
    // 不传坐标：menu.popup 的 x/y 是窗口客户区坐标，而我们这里只有 screenX/screenY，
    // 混用会把菜单推到离宠物很远的地方。交给系统取当前光标位置最准。
    window.petAPI.popupMenu('pet')
  }

  function handleBlur(): void {
    if (dragging.value) return
    pressed = false
    setInteractive(false)
  }

  onMounted(() => {
    window.addEventListener('mousemove', handleMouseMove, { passive: true })
    window.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('mouseleave', handleMouseLeave)
    window.addEventListener('contextmenu', handleContextMenu)
    window.addEventListener('blur', handleBlur)
    // 初始保持穿透
    window.petAPI.setIgnoreMouse(true)
    // 命中判定只能靠事件驱动，而这些时刻偏偏没有事件 —— 由主进程补一次光标位置
    disposePointerSync = window.petAPI.onPointerSync((point) => applyPointer(point.x, point.y))
  })

  onBeforeUnmount(() => {
    window.removeEventListener('mousemove', handleMouseMove)
    window.removeEventListener('mousedown', handleMouseDown)
    window.removeEventListener('mouseup', handleMouseUp)
    window.removeEventListener('mouseleave', handleMouseLeave)
    window.removeEventListener('contextmenu', handleContextMenu)
    window.removeEventListener('blur', handleBlur)
    disposePointerSync?.()
    disposePointerSync = null
  })

  return { hovering, dragging }
}
