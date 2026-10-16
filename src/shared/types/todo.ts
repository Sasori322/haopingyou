/**
 * 待办与便签的共享类型与常量。
 *
 * ## 为什么和剪贴板历史分开存
 * `docs/STATUS.md` 明确写了「**不要合并**」：待办是"值得留下的"，剪贴板历史是"刚才那几下"。
 * 两者的生命周期与淘汰规则完全不同 —— 剪贴板有 100 条 / 30 天的自动淘汰，待办一条都不该被
 * 悄悄丢掉。所以这里是独立的存储（`<userData>/todo/todo.json`）与独立的数据模型。
 *
 * ## 时间一律存绝对时间戳
 * 与久坐 / 喝水的口径一致（见技术约束 9）：`dueAt` 存绝对毫秒时间戳，
 * 跨休眠、跨重启都精确；不要存"还剩几分钟"这类相对量。
 */

/** 待办优先级。只有三档：再多就变成"选不出来" */
export type TodoPriority = 'low' | 'normal' | 'high'

export const TODO_PRIORITIES: readonly TodoPriority[] = ['low', 'normal', 'high']

export const TODO_PRIORITY_LABEL: Record<TodoPriority, string> = {
  low: '低',
  normal: '普通',
  high: '高'
}

export interface TodoItem {
  /** 唯一 id（时间戳 + 随机，无需 uuid 库） */
  id: string
  title: string
  done: boolean
  priority: TodoPriority
  /** 标签（如「工作」「家里」）。去重、≤6 条、每条 ≤16 字 */
  tags: string[]
  /** 截止时间（绝对毫秒时间戳）；null = 没有截止时间 */
  dueAt: number | null
  createdAt: number
  updatedAt: number
  /** 完成时刻；未完成时为 null */
  doneAt: number | null
  /**
   * 手动排序序号（升序）。**拖拽只改这个字段**，不动 `createdAt` ——
   * 否则"创建时间"会被排序操作污染，再也回不到原来的语义。
   */
  order: number
  /**
   * 「已经就哪个 dueAt 提醒过」的标记，值就是当时的 `dueAt`。
   *
   * 刻意用「等于哪个时刻」而不是布尔值：用户把截止时间从 18:00 改到 20:00 之后，
   * 应当**重新提醒一次**；布尔标记做不到这件事，只能手工清位，容易被漏掉。
   * 与 `dueAt` 相等即表示"这一版截止时间已经提醒过了"。
   */
  notifiedForDueAt: number | null
}

/** 便签底色。名字就是颜色名，取值由渲染层映射成具体色值 */
export type StickyColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple'

export const STICKY_COLORS: readonly StickyColor[] = ['yellow', 'green', 'blue', 'pink', 'purple']

export interface StickyNote {
  id: string
  text: string
  color: StickyColor
  /** 置顶的便签排在前面 */
  pinned: boolean
  createdAt: number
  updatedAt: number
  /**
   * 是否贴在桌面上（= 桌面上该有它独立的一块小窗口）。
   *
   * 与「置顶」是两件事：`pinned` 只影响它在列表里的排序，这个是"人在不在桌上"。
   * 老数据缺这个字段时一律按 `false` 恢复 —— 版本升级不该让用户桌面上凭空
   * 多出一堆纸条，要贴哪几张由他自己点。
   */
  onDesktop: boolean
  /**
   * 桌面便签窗口的位置与尺寸（屏幕坐标 / DIP）。`null` = 还没摆过，
   * 由主进程挑一个空位放（见 `src/main/notes/`）。
   *
   * 面板的位置刻意不持久化（这个项目里位置本来都不是配置项），但便签必须持久化：
   * 每张便签是一个独立窗口，不记位置的话每次启动它们会全部叠在同一个点上。
   */
  x: number | null
  y: number | null
  w: number | null
  h: number | null
}

/** 完成统计（设置页与面板的头部数字） */
export interface TodoStats {
  /** 全部条数（含已完成） */
  total: number
  /** 未完成条数 */
  active: number
  /** 已完成条数 */
  done: number
  /** 未完成且截止时间落在**今天**（本地日）或已过期的条数 */
  todayDue: number
  /** 未完成且已过期的条数 */
  overdue: number
}

/**
 * 写操作后统一回给渲染层的快照。
 *
 * 为什么不让写操作只回 `boolean`、然后靠 `TODO_CHANGED` 广播重读：
 * 那样渲染层每次操作都要多走一次 IPC 往返，而且"我刚点的这条到底成没成"在
 * 广播回来之前是不知道的。直接回快照最简单，广播只用于**另一个窗口**的同步。
 */
export interface TodoSnapshot {
  todos: TodoItem[]
  notes: StickyNote[]
  stats: TodoStats
  /** 数据文件绝对路径（设置页要显示"写在哪"，便于用户自己备份） */
  storageFile: string
}

// ---------------- 写操作的输入 ----------------

export interface TodoDraft {
  title: string
  priority: TodoPriority
  tags: string[]
  dueAt: number | null
}

/** 局部更新：只出现需要改的字段。全部可选，空对象是合法的 no-op */
export interface TodoPatch {
  title?: string
  priority?: TodoPriority
  tags?: string[]
  /** 显式传 null 表示"清掉截止时间" */
  dueAt?: number | null
}

export interface StickyDraft {
  text: string
  color: StickyColor
  /**
   * 新建时是否直接贴到桌面。**不传 = true**（"记一条便签"的意图本来就是"贴在那儿"）。
   * 面板 / 托盘 / 宠物右键这几个快速入口都走默认；只有设置页那种"先存着"的场景才显式传 false。
   */
  onDesktop?: boolean
}

/** 局部更新：只出现需要改的字段 */
export interface StickyPatch {
  text?: string
  color?: StickyColor
  /** 贴出 / 收起桌面便签 */
  onDesktop?: boolean
}

// ---------------- 限额（IPC 校验层与 UI 提示共用一份） ----------------

/** 待办标题上限。够写一句话，又不至于把列表撑垮 */
export const TODO_TITLE_MAX = 120
/** 标签条数与单条长度上限 */
export const TODO_TAGS_MAX = 6
export const TODO_TAG_MAX = 16
/** 便签正文上限 */
export const NOTE_TEXT_MAX = 2000

// ---------------- 桌面便签窗口 ----------------

/** 桌面便签的默认尺寸（DIP）。一张纸条的大小：够写几行，又不至于盖住小半个屏幕 */
export const NOTE_WIN_W = 220
export const NOTE_WIN_H = 180
/** 允许用户拖出来的尺寸区间。下限保证"色纸"的形状还在，上限防止把桌面糊住 */
export const NOTE_WIN_MIN_W = 150
export const NOTE_WIN_MIN_H = 110
export const NOTE_WIN_MAX_W = 640
export const NOTE_WIN_MAX_H = 720
/**
 * 同时贴在桌面上的便签上限。
 *
 * 每张便签是一个**独立的 Electron 窗口**（一个渲染进程），不是画在同一个大透明窗里的
 * ——后者会得到一个铺满屏幕的透明窗口，鼠标穿透只能逐像素切换，而这在本项目里是
 * 明确的高频禁忌（会让全系统鼠标卡死，见 `docs/STATUS.md` §四）。
 * 独立窗口没有这个问题，代价是内存：一个窗口几十 MB。所以给个上限兜住极端情况。
 */
export const NOTE_DESKTOP_MAX = 24

/** 截止时间的可接受区间（毫秒）。挡住 0 / NaN / 2699 年这类明显的脏值 */
export const TODO_DUE_MIN = Date.UTC(2000, 0, 1)
export const TODO_DUE_MAX = Date.UTC(2100, 0, 1)

/**
 * 截止提醒的评估周期（ms）。
 *
 * 比久坐 / 喝水的 5 秒松得多：那两条是"连续行为计时"，这条只需要"到点附近弹一次"，
 * 而截止时间的粒度本来就是分钟级。10 秒既让用户感觉不到延迟，又几乎不耗电
 * （每次 tick 只是遍历内存里几十条记录做一次数值比较，没有任何 I/O）。
 */
export const TODO_REMINDER_TICK_MS = 10_000
