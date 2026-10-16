import { BrowserWindow, app, screen } from 'electron'
import { join } from 'node:path'
import {
  NOTE_DESKTOP_MAX,
  NOTE_WIN_H,
  NOTE_WIN_MAX_H,
  NOTE_WIN_MAX_W,
  NOTE_WIN_MIN_H,
  NOTE_WIN_MIN_W,
  NOTE_WIN_W
} from '../../shared/types/todo'
import type { StickyColor, StickyNote } from '../../shared/types/todo'
import { todoRepo } from '../todo'
import { createLogger } from '../utils/logger'

const log = createLogger('desktopNotes')

/**
 * 桌面便签：**一张便签 = 一个独立窗口**。
 *
 * ## 为什么不做成"一个铺满屏幕的透明窗 + 里面画 N 张纸"
 * 那样确实省内存，但会得到一个覆盖整个工作区的窗口 —— 想让鼠标穿过纸与纸之间的空隙，
 * 只能逐像素切换穿透，而本项目的硬约束写得很清楚：**穿透切换只允许发生在边沿**
 * （高频调用会卡死全系统鼠标，见 `docs/STATUS.md` §四）。一条死路。
 *
 * ## 为什么不做成"塞进待办面板里"
 * 2026-10-16 之前就是那么做的（面板里一个「便签」页签）。便签的用途是"贴在那儿看得见"，
 * 挤进一个 320px 的窄窗翻页，反而丢了它最该有的样子。所以拆出来，各归各位：
 * 面板只管待办，便签管桌面。
 *
 * ## 位置必须持久化
 * 面板的位置刻意不持久化（这个项目里位置都不是配置项），但便签不行 ——
 * 每张便签是一个窗口，不记位置的话每次启动它们会全部叠在同一个点上。
 * 所以 `x/y/w/h` 落在便签数据里（`StickyNote`）。
 *
 * ## 唯一的同步口径
 * 数据是**唯一真相**，窗口只是它的投影。任何增删改之后都调 `syncDesktopNotes()` 对账：
 * 数据说该贴而没开的补开，数据说没贴却还开着的关掉。不要在别处直接开关窗口 ——
 * 那就是"两份状态互相追赶"的经典开局。
 */

/** 便签 id → 它的窗口。`Map` 的迭代顺序天然是打开顺序，正好用来分配空位 */
const windows = new Map<string, BrowserWindow>()

/** 拖动 / resize 落盘的防抖计时器：拖一次只写一次盘 */
const rectTimers = new Map<string, NodeJS.Timeout>()

/**
 * 等着"一开出来就把光标交给它"的便签 id。
 * 只在「记一条便签」这条路上有 —— 那次是用户明确要写的，光标必须先就位；
 * 而启动时恢复一屏便签则**绝不能**抢焦点，否则开机瞬间光标的落点就由便签决定了。
 */
const pendingFocus = new Set<string>()

/** 位置落盘前的安静时间。CSS 拖动会连续触发 `moved`，短了就变成高频写盘 */
const RECT_FLUSH_MS = 350

/**
 * 对账：把窗口集合收敛到"数据里 `onDesktop === true` 的那些便签"。
 *
 * 幂等，随便调多少次都行 —— 启动时恢复、IPC 改完数据后收尾、托盘"全部收起"，
 * 走的都是这一个函数。
 */
export function syncDesktopNotes(): void {
  const notes = todoRepo().listNotes()
  const wanted = new Map(notes.filter((n) => n.onDesktop).map((n) => [n.id, n] as const))

  // ① 数据里不该贴、窗口却还开着的 → 关掉
  for (const [id, win] of [...windows]) {
    if (wanted.has(id)) continue
    closeWindow(id, win)
  }

  // ② 数据里该贴、窗口还没开的 → 补开
  for (const [id, note] of wanted) {
    if (windows.has(id)) continue
    if (windows.size >= NOTE_DESKTOP_MAX) {
      // 撞上限：把数据改回"不贴"，否则数据说贴着、桌面却看不见，用户只会觉得丢东西了。
      // 这里不再递归 sync（setNoteDesktop 本身不触发同步），所以不会无限套娃。
      log.warn(`桌面便签已达上限 ${NOTE_DESKTOP_MAX} 张，${id} 未贴出`)
      todoRepo().setNoteDesktop(id, false)
      pendingFocus.delete(id)
      continue
    }
    openWindow(id, note)
  }
}

/**
 * 「记一条便签」：新建一张（默认空白）便签、直接贴到桌面，并让光标落进正文。
 *
 * 空白便签是**合法状态**（见 `todoStore.ts::repairNote`），所以这里不需要
 * "先有内容才能创建" —— 点一下，桌上就多一张等着你写的纸。这才是便签该有的入口：
 * 先落到纸上，再想写什么。
 */
export function createNoteOnDesktop(
  text = '',
  color: StickyColor = 'yellow',
  focus = true
): string {
  const note = todoRepo().addNote({ text, color, onDesktop: true })
  if (focus) pendingFocus.add(note.id)
  syncDesktopNotes()
  return note.id
}

/** 贴出一张便签（改数据 + 对账） */
export function showNoteOnDesktop(id: string): void {
  todoRepo().setNoteDesktop(id, true)
  syncDesktopNotes()
}

/** 从桌面收起一张便签（数据保留，随时能再贴） */
export function hideNoteFromDesktop(id: string): void {
  todoRepo().setNoteDesktop(id, false)
  syncDesktopNotes()
}

/** 退出前清场。不写 `onDesktop=false` —— 下次启动还要照原样恢复 */
export function closeAllNoteWindows(): void {
  for (const [id, win] of [...windows]) closeWindow(id, win)
}

export function getNoteWindow(id: string): BrowserWindow | null {
  const win = windows.get(id)
  return win && !win.isDestroyed() ? win : null
}

export function desktopNoteCount(): number {
  return windows.size
}

// ---------------- 内部 ----------------

function openWindow(id: string, note: StickyNote): void {
  const size = clampSize(note)
  const spot = resolveSpot(note, size.w, size.h)
  // 只有「记一条便签」会在这里命中；启动恢复时这个集合是空的
  const wantFocus = pendingFocus.delete(id)

  const win = new BrowserWindow({
    x: spot.x,
    y: spot.y,
    width: size.w,
    height: size.h,
    minWidth: NOTE_WIN_MIN_W,
    minHeight: NOTE_WIN_MIN_H,
    maxWidth: NOTE_WIN_MAX_W,
    maxHeight: NOTE_WIN_MAX_H,
    show: false,
    frame: false,
    // 圆角 + 投影都需要窗口透明：不透明的窗口四角照旧是方的（同待办面板的坑）
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    // 不占任务栏：桌面便签是"贴在屏幕上"的东西，不是任务（20 张就是 20 个图标）
    skipTaskbar: true,
    // 一直浮着：便签一旦被浏览器盖住就失去了存在的意义
    alwaysOnTop: true,
    // 影子自己用 CSS 画（系统影子在透明窗口上不生效，留着只会出现一圈怪边）
    hasShadow: false,
    title: '便签',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      devTools: !app.isPackaged
    }
  })

  win.on('moved', () => scheduleRectFlush(id))
  win.on('resize', () => scheduleRectFlush(id))

  win.on('closed', () => {
    const timer = rectTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      rectTimers.delete(id)
    }
    windows.delete(id)
  })

  win.once('ready-to-show', () => {
    win.show()
    // 默认**不**抢焦点：一次贴出一叠便签时，光标不该被最后一张顺走。
    // 只有 `wantFocus`（「记一条便签」）才主动聚焦。
    if (wantFocus) win.focus()
    // ⚠️ **第一次现身就把落点记下来**，不能等用户拖。
    // 不记的话，重启时每张便签都要重新 `pickFreeSpot`，而挑空位依赖创建顺序
    // （创建顺序又来自 `listNotes` 的"最近改过优先"）——用户会看到自己的便签
    // "每次开机都自己换地方"。这条踩过：早先只有 `moved` 事件才落盘。
    flushRect(id, win)
    log.info('桌面便签已贴出', id)
  })

  // `focus=1` 让渲染层把光标直接落到正文里 —— 用 URL 参数而不是多加一条 IPC：
  // 这个信息在窗口创建那一刻就定了，之后不会再变。
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void win.loadURL(`${devUrl}/notes.html?id=${encodeURIComponent(id)}${wantFocus ? '&focus=1' : ''}`)
  } else {
    void win.loadFile(
      join(__dirname, '../renderer/notes.html'),
      wantFocus ? { query: { id, focus: '1' } } : { query: { id } }
    )
  }

  windows.set(id, win)
}

function closeWindow(id: string, win: BrowserWindow): void {
  const timer = rectTimers.get(id)
  if (timer) {
    clearTimeout(timer)
    rectTimers.delete(id)
  }
  // 先落一次最终位置，再关 —— 不然"拖完立刻关"会丢掉最后一次移动
  flushRect(id, win)
  windows.delete(id)
  if (!win.isDestroyed()) win.close()
  // 两种原因都会走到这里：用户点了 ✕（便签已被删）或数据里 onDesktop 变回了 false。
  // 日志不区分，因为对这里来说都只是"这张不该再显示在桌面上了"。
  log.info('桌面便签已从桌面移除', id)
}

function scheduleRectFlush(id: string): void {
  const existing = rectTimers.get(id)
  if (existing) clearTimeout(existing)
  rectTimers.set(
    id,
    setTimeout(() => {
      rectTimers.delete(id)
      const win = windows.get(id)
      if (win) flushRect(id, win)
    }, RECT_FLUSH_MS)
  )
}

/**
 * 把窗口当前的位置与尺寸写回数据。
 *
 * `moved` / `resize` 事件在拖动过程中会连续打进来，但真正需要落盘的只有最后一帧 ——
 * 所以这里是"最后一次调用之后 350ms 才写"，不是每次都写。
 */
function flushRect(id: string, win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const b = win.getBounds()
  todoRepo().setNoteRect(id, { x: b.x, y: b.y, w: b.width, h: b.height })
}

/** 尺寸夹到允许区间。数据是用户可手改的，窗口尺寸不能信 */
function clampSize(note: StickyNote): { w: number; h: number } {
  return {
    w: clamp(note.w ?? NOTE_WIN_W, NOTE_WIN_MIN_W, NOTE_WIN_MAX_W),
    h: clamp(note.h ?? NOTE_WIN_H, NOTE_WIN_MIN_H, NOTE_WIN_MAX_H)
  }
}

/**
 * 定位置。
 *
 * 数据里有位置就用（但要**夹回工作区**：换过显示器、拔过外接屏之后，
 * 原来记在 (3000, 120) 的便签会落到看不见的地方，用户只会觉得"我的便签没了"）；
 * 没有就找空位 —— 新便签叠在旧便签上是最容易被投诉的那种"小问题"。
 */
function resolveSpot(note: StickyNote, w: number, h: number): { x: number; y: number } {
  const { workArea } = screen.getPrimaryDisplay()
  if (note.x !== null && note.y !== null) {
    return {
      x: clamp(note.x, workArea.x, Math.max(workArea.x, workArea.x + workArea.width - w)),
      y: clamp(note.y, workArea.y, Math.max(workArea.y, workArea.y + workArea.height - h))
    }
  }
  return pickFreeSpot(w, h, workArea)
}

/**
 * 挑一个不压住已有便签的空位：从工作区右下角起，先往上排，满了再往左挪一列。
 *
 * 之所以从**右下角**起：任务栏、图标都在别处，右下角通常是桌面最空的地方，
 * 而且和宠物（默认也在右下附近）错开一层正好。
 */
function pickFreeSpot(
  w: number,
  h: number,
  workArea: { x: number; y: number; width: number; height: number }
): { x: number; y: number } {
  const gap = 12
  const margin = 20
  const taken = [...windows.values()]
    .filter((win) => !win.isDestroyed())
    .map((win) => win.getBounds())
  const startX = workArea.x + workArea.width - w - margin
  const startY = workArea.y + workArea.height - h - margin

  for (let col = 0; col < 8; col++) {
    for (let row = 0; row < 8; row++) {
      const x = startX - col * (w + gap)
      const y = startY - row * (h + gap)
      if (x < workArea.x || y < workArea.y) continue
      const rect = { x, y, width: w, height: h }
      if (!taken.some((t) => intersects(t, rect))) return { x, y }
    }
  }
  // 实在排不开就叠在起点，至少还在屏幕里
  return { x: startX, y: startY }
}

function intersects(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
