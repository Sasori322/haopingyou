import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { IPC } from '../../shared/ipc'
import type { TodoSnapshot } from '../../shared/types/todo'
import { createLogger } from '../utils/logger'
import { JsonTodoRepository } from './todoStore'
import type { TodoRepository } from './todoStore'

const log = createLogger('todo')

let repo: TodoRepository | null = null

/** app ready 后调用（由 registerIpc 触发，与 initClipboard 同一时机） */
export function initTodo(): void {
  if (repo) return
  const file = join(app.getPath('userData'), 'todo', 'todo.json')
  repo = new JsonTodoRepository(file)
  const stats = repo.stats()
  log.info('待办与便签已就绪 存储', file, `待办 ${stats.total} 条（未完成 ${stats.active}）· 便签 ${repo.listNotes().length} 条`)
}

/**
 * 取 Repository。**业务代码只该用这个出口拿数据**，不要直接 new 实现类 ——
 * 将来换 SQLite 时，替换点就在这一行。
 */
export function todoRepo(): TodoRepository {
  if (!repo) throw new Error('待办数据层尚未初始化（应在 app ready 后先调 initTodo）')
  return repo
}

export function todoSnapshot(): TodoSnapshot {
  const r = todoRepo()
  return {
    todos: r.listTodos(),
    notes: r.listNotes(),
    stats: r.stats(),
    storageFile: r.file
  }
}

/**
 * 写操作之后的统一收尾：取最新快照 + 广播给所有窗口 + 回给调用方。
 *
 * 设置页与旁挂小面板是两个独立窗口，都可能开着；只把结果回给"发起操作的那个窗口"
 * 会让另一个窗口显示过期数据。所以写操作一律广播，渲染层用 `onChanged` 订阅。
 */
export function todoAfterWrite(): TodoSnapshot {
  const snapshot = todoSnapshot()
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(IPC.TODO_CHANGED, snapshot)
  }
  return snapshot
}

/** 进程退出前同步落盘 */
export function flushTodo(): void {
  repo?.flush()
}
