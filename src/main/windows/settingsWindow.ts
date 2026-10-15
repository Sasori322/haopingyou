import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { createLogger } from '../utils/logger'

const log = createLogger('settingsWindow')

let settingsWindow: BrowserWindow | null = null

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null
}

export function openSettingsWindow(): BrowserWindow {
  const existing = getSettingsWindow()
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return existing
  }

  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 860,
    minHeight: 560,
    title: '好屏友 · 设置',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f5f6fa',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      devTools: !app.isPackaged
    }
  })

  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    settingsWindow = null
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void win.loadURL(`${devUrl}/settings.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/settings.html'))
  }

  settingsWindow = win
  log.info('设置窗口已创建')
  return win
}

/** 广播给所有窗口（设置变更等） */
export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(channel, payload)
  }
}
