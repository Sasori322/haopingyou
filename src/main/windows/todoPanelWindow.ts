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
 */
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
    width: 320,
    height: 500,
    minWidth: 264,
    minHeight: 340,
    show: false,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    maximizable: false,
    title: '待办与便签',
    backgroundColor: '#ffffff',
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
    const x = Math.max(workArea.x, workArea.x + workArea.width - 320 - 16)
    const y = workArea.y + Math.max(0, Math.round((workArea.height - 500) / 2))
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
