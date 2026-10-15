/**
 * 尾触发节流：等待期内只保留最后一次调用，保证最终状态一定送达。
 * 用于拖拽坐标上报（30fps）等高频 IPC。
 */
export function throttleTrailing<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number
): (...args: A) => void {
  let last = 0
  let timer: NodeJS.Timeout | null = null
  let lastArgs: A | null = null

  const invoke = (): void => {
    last = Date.now()
    timer = null
    if (lastArgs) {
      const args = lastArgs
      lastArgs = null
      fn(...args)
    }
  }

  return (...args: A): void => {
    const now = Date.now()
    const remaining = waitMs - (now - last)
    lastArgs = args
    if (remaining <= 0) {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      invoke()
    } else if (!timer) {
      timer = setTimeout(invoke, remaining)
    }
  }
}
