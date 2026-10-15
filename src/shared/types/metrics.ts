/** 系统监控指标（M3 使用，M1 仅定义类型） */

export interface SystemMetrics {
  ts: number
  /** CPU 总占用 0-100 */
  cpu: number
  /** 内存占用率 0-100 */
  memUsedPct: number
  memUsedGB: number
  memTotalGB: number
  /** 下行字节/秒 */
  rxBytesPerSec: number
  /** 上行字节/秒 */
  txBytesPerSec: number
  /** 网络是否活跃 */
  netActive: boolean
  /** 占用最高的进程（可选，需用户开启） */
  topProcess?: { name: string; cpu: number }
}
