import { TODO_REMINDER_TICK_MS } from '../../shared/types/todo'
import { notifier } from '../services/notifier'
import { createLogger } from '../utils/logger'
import { todoAfterWrite, todoRepo } from './index'

const log = createLogger('todoRemind')

/**
 * 待办截止提醒。
 *
 * ## 为什么单独一个调度器
 * 久坐 / 喝水是"连续行为计时"，番茄钟是"一段一段的倒计时"，而待办是**一堆各自独立的
 * 绝对时刻**。硬塞进 `reminderScheduler` 只会让那边的状态机多出一堆不相干的字段，
 * 所以自己一个 tick，但**投递仍然只经 `notifier`**（技术约束 8）——
 * 免打扰、沉浸时挂起这些横切规则因此自动生效，不用在这里再写一遍。
 *
 * ## 两个刻意的规则
 *
 * 1. **提醒过就记下"提醒的是哪个 dueAt"**（`notifiedForDueAt`），而不是一个布尔标记。
 *    用户把截止时间从 18:00 改到 20:00，20:00 应当重新提醒一次 —— 布尔标记做不到。
 *
 * 2. **启动前就已经过期的旧账，只标记不弹窗**。合上电脑三天再打开应用，
 *    不该被一屏"这三件事都过期了"的弹窗糊脸；这些条目在面板与设置页里会显示成红色
 *    的"已过期"，用户看得到，只是不主动打扰。这与 STATUS.md 里已写明的
 *    "提醒只在进程运行期间有效"是同一条已知边界。
 */
class TodoReminder {
  private timer: NodeJS.Timeout | null = null
  /** 本次进程的启动时刻：早于它的截止时间视为"旧账"，不弹窗 */
  private startedAt = 0

  start(): void {
    if (this.timer) return
    this.startedAt = Date.now()
    this.timer = setInterval(() => this.tick(), TODO_REMINDER_TICK_MS)
    // 立刻跑一次：既能把启动前的旧账静默标记掉，也能接住"上次退出前 10 秒内到点"的漏网之鱼
    this.tick()
    log.info('待办截止提醒已启动，评估周期', TODO_REMINDER_TICK_MS, 'ms')
  }

  /** 数据被改动过之后手动催一次（新增/编辑了一条已到点的待办） */
  refresh(): void {
    if (this.timer) this.tick()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  private tick(): void {
    const repo = todoRepo()
    const now = Date.now()
    let changed = false
    for (const todo of repo.listTodos()) {
      if (todo.done || todo.dueAt === null) continue
      if (todo.dueAt > now) continue
      if (todo.notifiedForDueAt === todo.dueAt) continue
      // 无论如何都先标记，避免每 10 秒重复提醒一次（这就是"提醒后重新起算"的等价物）
      repo.markNotifiedForDue(todo.id, todo.dueAt)
      changed = true
      if (todo.dueAt < this.startedAt) {
        log.info(`待办启动前已过期，仅标记不打扰：${todo.title}`)
        continue
      }
      notifier.notify({
        kind: 'todo',
        title: '待办到点了',
        body: `「${todo.title}」到截止时间了`,
        petState: 'idle',
        sound: true
      })
    }
    if (changed) todoAfterWrite()
  }
}

export const todoReminder = new TodoReminder()
