import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createLogger } from '../utils/logger'
import {
  NOTE_TEXT_MAX,
  STICKY_COLORS,
  TODO_PRIORITIES,
  TODO_TAG_MAX,
  TODO_TAGS_MAX,
  TODO_TITLE_MAX
} from '../../shared/types/todo'
import type {
  StickyColor,
  StickyDraft,
  StickyNote,
  StickyPatch,
  TodoDraft,
  TodoItem,
  TodoPatch,
  TodoPriority,
  TodoStats
} from '../../shared/types/todo'

const log = createLogger('todoStore')

/**
 * 待办与便签的 Repository 接口层。
 *
 * `docs/STATUS.md` 对这块的原话是「需要一个 Repository 接口层，将来若要全文检索再评估 SQLite」——
 * 所以业务代码（IPC 层、截止提醒）**只依赖这个接口**，不认识 JSON 文件。
 * 将来换成 SQLite 时只要再写一个实现类，上层一行都不用动。
 */
export interface TodoRepository {
  /** 数据文件绝对路径（设置页展示"写在哪"） */
  readonly file: string

  listTodos(): TodoItem[]
  addTodo(draft: TodoDraft): TodoItem
  updateTodo(id: string, patch: TodoPatch): TodoItem | null
  removeTodo(id: string): boolean
  setDone(id: string, done: boolean): TodoItem | null
  /**
   * 按给定的 id 顺序重排**这些条之间**的相对次序。
   * 未出现在 ids 里的条目顺序不受影响（实现见下），这样"只重排进行中列表"不会
   * 把已完成条目的次序一起打乱。
   */
  reorderTodos(ids: string[]): boolean
  clearDoneTodos(): number
  /** 标记"某条已就某个 dueAt 提醒过" */
  markNotifiedForDue(id: string, dueAt: number): void

  listNotes(): StickyNote[]
  addNote(draft: StickyDraft): StickyNote
  updateNote(id: string, patch: StickyPatch): StickyNote | null
  removeNote(id: string): boolean
  setNotePinned(id: string, pinned: boolean): StickyNote | null
  /** 贴到桌面 / 从桌面收起（不动正文与颜色） */
  setNoteDesktop(id: string, onDesktop: boolean): StickyNote | null
  /**
   * 记下桌面便签窗口被拖到哪、拉成多大。
   *
   * 刻意**不返回**便签也不改 `updatedAt`：这两个字段是窗口自己的"住址"，
   * 不是用户对便签内容的编辑 —— 拖一下位置就让它在"最近改过"里插队、还把新快照
   * 广播给所有窗口，纯属噪声（拖动过程中会调很多次）。
   */
  setNoteRect(id: string, rect: NoteRect): void

  stats(): TodoStats
  /** 进程退出前同步落盘 */
  flush(): void
}

/** 桌面便签窗口的摆放（屏幕坐标 / DIP）。见 `StickyNote.setNoteRect` 的注释 */
export interface NoteRect {
  x: number
  y: number
  w: number
  h: number
}

/** 落盘结构。带 version 是为了将来换存储时能识别旧文件 */
interface PersistedShape {
  version: number
  todos: TodoItem[]
  notes: StickyNote[]
}

const SCHEMA_VERSION = 1

/**
 * JSON 单文件实现。原子写（tmp + rename）+ 180ms 防抖 —— 与 `ClipboardStore` 同一套手法。
 *
 * 为什么不上 SQLite：单用户、条目量在几十到几百条、查询就是"全量取回再排序"，
 * JSON 完全够用，而且用户能直接打开备份。真到了要全文检索那天再换（接口层就是为那天准备的）。
 */
export class JsonTodoRepository implements TodoRepository {
  readonly file: string
  private todos: TodoItem[] = []
  private notes: StickyNote[] = []
  private writeTimer: NodeJS.Timeout | null = null

  constructor(file: string) {
    this.file = file
    mkdirSync(dirname(file), { recursive: true })
    this.load()
  }

  // ---------------- 待办 ----------------

  listTodos(): TodoItem[] {
    // 统一按 order 升序出口。渲染层要分组（进行中 / 已完成）是它自己的事，
    // Repository 只负责"稳定的顺序"这一件事。
    return [...this.todos].sort((a, b) => a.order - b.order).map((t) => cloneTodo(t))
  }

  addTodo(draft: TodoDraft): TodoItem {
    const now = Date.now()
    const todo: TodoItem = {
      id: makeId('t'),
      title: draft.title,
      done: false,
      priority: draft.priority,
      tags: [...draft.tags],
      dueAt: draft.dueAt,
      createdAt: now,
      updatedAt: now,
      doneAt: null,
      // 新建的排在最前：就在输入框下面，用户能立刻看到自己刚记的东西
      order: this.nextTopOrder(),
      // 创建时截止时间就已经过去（用户补录一条旧账）→ 直接视为"已提醒过"，
      // 免得存下的瞬间就被截止提醒弹一次。见 todoReminder 的同款判断。
      notifiedForDueAt: draft.dueAt !== null && draft.dueAt <= now ? draft.dueAt : null
    }
    this.todos.push(todo)
    this.scheduleWrite()
    return cloneTodo(todo)
  }

  updateTodo(id: string, patch: TodoPatch): TodoItem | null {
    const todo = this.todos.find((t) => t.id === id)
    if (!todo) return null
    if (patch.title !== undefined) todo.title = patch.title
    if (patch.priority !== undefined) todo.priority = patch.priority
    if (patch.tags !== undefined) todo.tags = [...patch.tags]
    if (patch.dueAt !== undefined) {
      // 改了截止时间：只有真的变了才清掉"已提醒"标记 —— 否则用户每编辑一次标题，
      // 都会把提醒资格重置，同一时刻被提醒第二遍。
      if (patch.dueAt !== todo.dueAt) {
        todo.dueAt = patch.dueAt
        const now = Date.now()
        todo.notifiedForDueAt = patch.dueAt !== null && patch.dueAt <= now ? patch.dueAt : null
      }
    }
    todo.updatedAt = Date.now()
    this.scheduleWrite()
    return cloneTodo(todo)
  }

  removeTodo(id: string): boolean {
    const idx = this.todos.findIndex((t) => t.id === id)
    if (idx < 0) return false
    this.todos.splice(idx, 1)
    this.scheduleWrite()
    return true
  }

  setDone(id: string, done: boolean): TodoItem | null {
    const todo = this.todos.find((t) => t.id === id)
    if (!todo) return null
    if (todo.done !== done) {
      todo.done = done
      todo.doneAt = done ? Date.now() : null
      todo.updatedAt = Date.now()
      this.scheduleWrite()
    }
    return cloneTodo(todo)
  }

  reorderTodos(ids: string[]): boolean {
    const targets = ids
      .map((id) => this.todos.find((t) => t.id === id))
      .filter((t): t is TodoItem => t !== undefined)
    if (targets.length < 2) return false
    // 把这些条目**本来占用的那些 order 槽位**取出来升序排列，再按新的先后顺序填回去。
    // 好处：不在 ids 里的条目（比如已完成列表）order 完全不受影响，
    // 也就不会出现"重排进行中列表把已完成条目挤到前面"这种事。
    const slots = targets.map((t) => t.order).sort((a, b) => a - b)
    targets.forEach((todo, index) => {
      todo.order = slots[index]
    })
    this.scheduleWrite()
    return true
  }

  clearDoneTodos(): number {
    const before = this.todos.length
    this.todos = this.todos.filter((t) => !t.done)
    const removed = before - this.todos.length
    if (removed > 0) this.scheduleWrite()
    return removed
  }

  markNotifiedForDue(id: string, dueAt: number): void {
    const todo = this.todos.find((t) => t.id === id)
    if (!todo) return
    todo.notifiedForDueAt = dueAt
    this.scheduleWrite()
  }

  // ---------------- 便签 ----------------

  listNotes(): StickyNote[] {
    // 置顶优先，其次按最近改过排序 —— 便签的用法就是"随手记、随手翻"，最近动过的应该在前面
    return [...this.notes]
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.updatedAt - a.updatedAt
      })
      .map((n) => ({ ...n }))
  }

  addNote(draft: StickyDraft): StickyNote {
    const now = Date.now()
    const note: StickyNote = {
      id: makeId('n'),
      text: draft.text,
      color: draft.color,
      pinned: false,
      createdAt: now,
      updatedAt: now,
      // 没说就不贴桌面是反的：「记一条便签」的意图本来就是"贴在那儿给我看见"。
      // 只有设置页那种"先存着"的场景才显式传 false。
      onDesktop: draft.onDesktop !== false,
      // 位置留空 = 交给 `src/main/notes/` 挑个空位，别让新便签压住旧的
      x: null,
      y: null,
      w: null,
      h: null
    }
    this.notes.push(note)
    this.scheduleWrite()
    return { ...note }
  }

  updateNote(id: string, patch: StickyPatch): StickyNote | null {
    const note = this.notes.find((n) => n.id === id)
    if (!note) return null
    if (patch.text !== undefined) note.text = patch.text
    if (patch.color !== undefined) note.color = patch.color
    if (patch.onDesktop !== undefined) note.onDesktop = patch.onDesktop
    note.updatedAt = Date.now()
    this.scheduleWrite()
    return { ...note }
  }

  removeNote(id: string): boolean {
    const idx = this.notes.findIndex((n) => n.id === id)
    if (idx < 0) return false
    this.notes.splice(idx, 1)
    this.scheduleWrite()
    return true
  }

  setNotePinned(id: string, pinned: boolean): StickyNote | null {
    const note = this.notes.find((n) => n.id === id)
    if (!note) return null
    note.pinned = pinned
    note.updatedAt = Date.now()
    this.scheduleWrite()
    return { ...note }
  }

  setNoteDesktop(id: string, onDesktop: boolean): StickyNote | null {
    const note = this.notes.find((n) => n.id === id)
    if (!note) return null
    // 本来就贴在外面又点了一次「贴到桌面」→ 不写盘、不动 updatedAt，
    // 否则用户连点两下就会把这张便签顶到"最近改过"的最前面。
    if (note.onDesktop !== onDesktop) {
      note.onDesktop = onDesktop
      note.updatedAt = Date.now()
      this.scheduleWrite()
    }
    return { ...note }
  }

  setNoteRect(id: string, rect: NoteRect): void {
    const note = this.notes.find((n) => n.id === id)
    if (!note) return
    if (
      note.x === rect.x &&
      note.y === rect.y &&
      note.w === rect.w &&
      note.h === rect.h
    ) {
      return
    }
    note.x = rect.x
    note.y = rect.y
    note.w = rect.w
    note.h = rect.h
    // 不碰 updatedAt：摆位置不是编辑内容。180ms 防抖会把拖动过程中的高频调用合并成一次落盘
    this.scheduleWrite()
  }

  // ---------------- 统计 ----------------

  stats(): TodoStats {
    const now = Date.now()
    const endOfToday = endOfLocalDay(now)
    let active = 0
    let done = 0
    let todayDue = 0
    let overdue = 0
    for (const t of this.todos) {
      if (t.done) {
        done++
        continue
      }
      active++
      if (t.dueAt === null) continue
      if (t.dueAt < now) {
        overdue++
        todayDue++
      } else if (t.dueAt <= endOfToday) {
        todayDue++
      }
    }
    return { total: this.todos.length, active, done, todayDue, overdue }
  }

  // ---------------- 落盘 ----------------

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    this.writeNow()
  }

  private nextTopOrder(): number {
    if (this.todos.length === 0) return 0
    return Math.min(...this.todos.map((t) => t.order)) - 1
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PersistedShape>
      const todos = Array.isArray(raw.todos) ? raw.todos : []
      const notes = Array.isArray(raw.notes) ? raw.notes : []
      // 文件是用户可编辑的（也是可手改备份的），所以每个字段都要能接住脏值：
      // 一条坏记录不该让整份清单读不出来。
      this.todos = todos
        .map((t, index) => repairTodo(t, index))
        .filter((t): t is TodoItem => t !== null)
      this.notes = notes
        .map((n) => repairNote(n))
        .filter((n): n is StickyNote => n !== null)
      const dropped = todos.length - this.todos.length + (notes.length - this.notes.length)
      if (dropped > 0) log.warn('待办/便签有', dropped, '条记录格式无效已跳过')
    } catch (error) {
      log.error('读取待办数据失败，回退为空：', error)
      this.todos = []
      this.notes = []
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      this.writeNow()
    }, 180)
  }

  private writeNow(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const payload: PersistedShape = {
        version: SCHEMA_VERSION,
        todos: this.todos,
        notes: this.notes
      }
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      log.error('写待办数据失败：', error)
    }
  }
}

// ---------------- 小工具 ----------------

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
}

function cloneTodo(todo: TodoItem): TodoItem {
  return { ...todo, tags: [...todo.tags] }
}

/** 本地日 23:59:59.999 的时间戳 —— 「今天到期」判定用 */
function endOfLocalDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(23, 59, 59, 999)
  return d.getTime()
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 修复一条从磁盘读出的待办。
 * 返回 null 表示这条实在救不回来（缺 id 或缺标题），直接丢弃 —— 与其把一个
 * "没有标题的空壳"塞进列表让用户困惑，不如丢一条并在日志里说清楚。
 */
function repairTodo(raw: unknown, index: number): TodoItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const t = raw as Record<string, unknown>
  const id = typeof t.id === 'string' && t.id.length > 0 ? t.id : null
  const title = typeof t.title === 'string' ? t.title.slice(0, TODO_TITLE_MAX) : ''
  if (!id || title.length === 0) return null
  const priority: TodoPriority =
    typeof t.priority === 'string' && (TODO_PRIORITIES as readonly string[]).includes(t.priority)
      ? (t.priority as TodoPriority)
      : 'normal'
  const tags = Array.isArray(t.tags)
    ? t.tags
        .filter((x): x is string => typeof x === 'string' && x.length > 0)
        .slice(0, TODO_TAGS_MAX)
        .map((x) => x.slice(0, TODO_TAG_MAX))
    : []
  const dueAt = isFiniteNumber(t.dueAt) ? t.dueAt : null
  const createdAt = isFiniteNumber(t.createdAt) ? t.createdAt : Date.now()
  const updatedAt = isFiniteNumber(t.updatedAt) ? t.updatedAt : createdAt
  const done = t.done === true
  const doneAt = isFiniteNumber(t.doneAt) ? t.doneAt : null
  // order 缺失（老文件）时按读取顺序补，保证顺序稳定
  const order = isFiniteNumber(t.order) ? t.order : index
  const notifiedForDueAt = isFiniteNumber(t.notifiedForDueAt) ? t.notifiedForDueAt : null
  return { id, title, done, priority, tags, dueAt, createdAt, updatedAt, doneAt, order, notifiedForDueAt }
}

function repairNote(raw: unknown): StickyNote | null {
  if (typeof raw !== 'object' || raw === null) return null
  const n = raw as Record<string, unknown>
  const id = typeof n.id === 'string' && n.id.length > 0 ? n.id : null
  const text = typeof n.text === 'string' ? n.text.slice(0, NOTE_TEXT_MAX) : ''
  // 只认 id：正文**可以是空的**。桌面便笺的语义就是"写空了也留着"，删不删由用户决定，
  // 不该由数据层替他做主（待办标题就不同，空标题没有意义，那边仍然拒收）。
  if (!id) return null
  const color: StickyColor =
    typeof n.color === 'string' && (STICKY_COLORS as readonly string[]).includes(n.color)
      ? (n.color as StickyColor)
      : 'yellow'
  const createdAt = isFiniteNumber(n.createdAt) ? n.createdAt : Date.now()
  const updatedAt = isFiniteNumber(n.updatedAt) ? n.updatedAt : createdAt
  // `onDesktop` 缺字段 = 这份数据比"桌面便签"这个功能更早 → 一律当不贴桌面。
  // 升级后桌面上不会凭空冒出一排纸条，要贴哪几张由用户自己点。
  return {
    id,
    text,
    color,
    pinned: n.pinned === true,
    createdAt,
    updatedAt,
    onDesktop: n.onDesktop === true,
    ...readNoteRect(n)
  }
}

/**
 * 读出桌面便签窗口的摆放。**四个数缺一不可**：x/y/w/h 任意一个坏掉就整组作废，
 * 交给主进程重新挑位置 —— 半组脏值（比如有 x 没 y）会让窗口落到屏幕外的怪地方，
 * 用户只会看到"便签不见了"。
 */
function readNoteRect(n: Record<string, unknown>): Pick<StickyNote, 'x' | 'y' | 'w' | 'h'> {
  const { x, y, w, h } = n
  if (isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(w) && isFiniteNumber(h)) {
    return { x, y, w, h }
  }
  return { x: null, y: null, w: null, h: null }
}
