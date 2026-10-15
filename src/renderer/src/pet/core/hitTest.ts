export interface HitRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 几何命中判定：以坐标反查为准，elementFromPoint 仅作交叉验证。
 *
 * 之所以不直接用事件 target：穿透模式下 Electron 转发过来的 mousemove
 * 其 target 在不同版本 / 场景下并不稳定，坐标反查最可靠。
 */
export function hitTest(rect: HitRect, x: number, y: number, pad = 8): boolean {
  return (
    x >= rect.x - pad && x <= rect.x + rect.w + pad && y >= rect.y - pad && y <= rect.y + rect.h + pad
  )
}
