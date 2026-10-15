import { BrowserWindow, app, screen } from 'electron'
import { join } from 'node:path'
import { IPC } from '../../shared/ipc'
import { createLogger } from '../utils/logger'

const log = createLogger('todoPanelWin')

let panelWindow: BrowserWindow | null = null
/** 待消费的"聚焦快速录入框"请求：渲染层还没就绪时先记下，ready-to-show 时补发 */
let pendingFocusQuickAdd = false

/**
 * 旁挂小面板。
 *
 * ## 为什么必须是独立窗口（而不是塞进设置页、也不是放大宠物窗口）
 * `docs/STATUS.md` 的原话是「独立窗口，**不放大宠物窗口的拦截面积**」。
 * 这句话是硬约束：宠物窗口的鼠标拦截区是按 `manifest.bounds` 逐像素算出来的，
 * 往上贴任何常驻 UI，都会让"看着穿过去的地方其实挡住了鼠标"。
 *
 * ## 为什么无边框
 * 常驻旁挂的东西带一条 Windows 标题栏太占地方，也不像"挂着的一张纸"。
 * 拖动靠 CSS 的 `-webkit-app-region: drag`（见面板样式里的 header），
 * 关闭按钮在面板自己头上，所以不会出现"没有标题栏就关不掉"。
 *
 * ## 为什么需要 `transparent`（2026-10-15 加）
 * 圆角。无边框窗口在 Windows 上通体是一块**直角**矩形，`border-radius` 只作用于
 * 渲染内容，四角照旧是窗口底色 —— 看上去还是方的。想让"椭圆角"真的成立，
 * 窗口自己必须透明，圆角由 CSS 画、四角由系统露出桌面。
 * 代价有两条，都是可接受的：
 *  1. 窗口矩形外的 `PANEL_PAD` 边距（用来放投影）是**透明但仍会命中鼠标**的 ——
 *     不过那块本来就是窗口的 resize 热区，用户在那儿按下本来就是"拖边框"，不违和；
 *  2. 透明窗口拿不到系统投影，浮起感只能靠 CSS `box-shadow` 补，所以要留边距。
 * `PANEL_PAD` 就是为此存在的：窗口 = 内容 + 一圈透明边距。
 */

/**
 * 内容区尺寸（DIP）。面板的默认大小，也是 `minWidth/minHeight` 的基准。
 * 单独抽出来是因为初始位置计算也要用 —— 写死两处必然漂移。
 */
const PANEL_W = 320
const PANEL_H = 500
/** 给投影留的透明边距，四边各一份（渲染层的 `.todo-root` 用 `inset` 对齐） */
const PANEL_PAD = 8
export function openTodoPanel(options?: {
  focusQuickAdd?: boolean
  /**
   * 直开某个页签（渲染层读 `location.hash`）。
   * **只在新建窗口时生效**：面板已经开着就只是把它唤到前面，不切页签
   * —— 目前唯一的调用方是自检钩子，不值得为它多加一条 IPC。
   */
  initialTab?: 'todo' | 'notes'
}): BrowserWindow {
  const wantFocus = options?.focusQuickAdd === true
  const initialTab = options?.initialTab
  const existing = getTodoPanel()
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    if (wantFocus) {
      pendingFocusQuickAdd = false
      existing.webContents.send(IPC.TODO_PANEL_FOCUS_QUICK_ADD)
    }
    return existing
  }

  const win = new BrowserWindow({
    // 窗口尺寸 = 内容 + 两侧透明边距，见 PANEL_PAD 的注释
    width: PANEL_W + PANEL_PAD * 2,
    height: PANEL_H + PANEL_PAD * 2,
    minWidth: 264 + PANEL_PAD * 2,
    minHeight: 340 + PANEL_PAD * 2,
    show: false,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    maximizable: false,
    title: '待办与便签',
    // 透明窗口 + CSS 圆角：透明窗口的底色必须带 alpha，写 `#ffffff` 会把四角填成白色，
    // 圆角就白做了（`transparent` 与不透明背景色同时给，Windows 上以后者为准）。
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      devTools: !app.isPackaged
    }
  })

  // 贴主屏工作区右缘打开：旁挂面板的默认位置就该是"屏幕边上"。
  // 位置刻意不持久化（与宠物位置同一口径：这个项目里位置都不是配置项）。
  try {
    const { workArea } = screen.getPrimaryDisplay()
    const x = Math.max(workArea.x, workArea.x + workArea.width - (PANEL_W + PANEL_PAD * 2) - 16)
    const y = workArea.y + Math.max(0, Math.round((workArea.height - (PANEL_H + PANEL_PAD * 2)) / 2))
    win.setPosition(x, y)
  } catch (error) {
    log.warn('计算面板初始位置失败，使用默认位置', error)
  }

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
    if (wantFocus) {
      pendingFocusQuickAdd = false
      win.webContents.send(IPC.TODO_PANEL_FOCUS_QUICK_ADD)
    } else if (pendingFocusQuickAdd) {
      pendingFocusQuickAdd = false
      win.webContents.send(IPC.TODO_PANEL_FOCUS_QUICK_ADD)
    }
    log.info('待办面板已打开')
  })

  win.on('closed', () => {
    panelWindow = null
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const hash = initialTab === 'notes' ? 'notes' : ''
  if (!app.isPackaged && devUrl) {
    void win.loadURL(`${devUrl}/todo.html${hash ? `#${hash}` : ''}`)
  } else {
    void win.loadFile(
      join(__dirname, '../renderer/todo.html'),
      hash ? { hash } : undefined
    )
  }

  panelWindow = win
  return win
}

export function getTodoPanel(): BrowserWindow | null {
  return panelWindow && !panelWindow.isDestroyed() ? panelWindow : null
}

export function closeTodoPanel(): void {
  const win = getTodoPanel()
  if (win) win.close()
}

/** 托盘菜单：已开就关，没开就开（与剪贴板面板同一套交互） */
export function toggleTodoPanel(): void {
  if (getTodoPanel()) {
    closeTodoPanel()
    return
  }
  void openTodoPanel()
}
