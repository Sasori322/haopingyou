import { BrowserWindow, app } from 'electron'
import { join } from 'node:path'
import { IPC } from '../../shared/ipc'
import { listClipboard } from '../clipboard'
import { createLogger } from '../utils/logger'
import { broadcast } from './settingsWindow'

const log = createLogger('clipBoardWin')

let panelWindow: BrowserWindow | null = null

/**
 * 打开剪贴板历史面板。
 *
 * 快照式：
 *  - 渲染层只读一次 list()；store 写完后由 store 主动广播 CLIPBOARD_CHANGED，
 *    渲染层订阅此事件决定是否重读，不做轮询。
 *  - 主进程不主动给面板 push 列表——只有状态变化时才在面板上加个红点。
 *
 * 反复点同一个入口时：聚焦已有窗口，不重复创建——避免日积月累的窗口泄漏。
 */
export function openClipboardPanel(): BrowserWindow {
  const existing = getClipboardPanel()
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    // 让渲染层重新读一次最新数据，避免用户在面板开了一段时间后再点菜单时显示过期内容
    existing.webContents.send(IPC.SETTINGS_CHANGED, undefined) // 用不到，但留个口子
    broadcast(IPC.CLIPBOARD_CHANGED, listClipboard().length)
    return existing
  }

  const win = new BrowserWindow({
    width: 640,
    height: 540,
    minWidth: 460,
    minHeight: 360,
    title: '剪贴板历史',
    show: false,
    autoHideMenuBar: true,
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

  win.once('ready-to-show', () => {
    win.show()
    log.info('剪贴板面板已打开')
  })

  win.on('closed', () => {
    panelWindow = null
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void win.loadURL(`${devUrl}/clipboard.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/clipboard.html'))
  }

  panelWindow = win
  return win
}

export function getClipboardPanel(): BrowserWindow | null {
  return panelWindow && !panelWindow.isDestroyed() ? panelWindow : null
}

export function closeClipboardPanel(): void {
  const win = getClipboardPanel()
  if (win) win.close()
}

/**
 * 全局快捷键的回调：面板已开就关掉，没开就开。
 * 单独提出来是因为 ipcRegistry.applySideEffects 也要用，
 * 而那里不应该关心窗口的内部状态。
 */
export function toggleClipboardPanel(): void {
  const win = getClipboardPanel()
  if (win) {
    closeClipboardPanel()
    return
  }
  void openClipboardPanel()
}
